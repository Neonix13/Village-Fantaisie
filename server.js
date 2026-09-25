const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { getPageData } = require('./page');
const { ROLES, PRIORITY } = require('./roles');
const VFGame = require('./public/game.js');

// Serveur hote : il detient LA partie (regles dans public/game.js) et la partage en direct avec
// tous les telephones connectes (WebSocket). Le paquet de cartes ne quitte jamais ce processus.
function createHost(opts = {}) {
  const port = opts.port || process.env.PORT || 3000;
  const saveFile = opts.saveFile === undefined ? path.join(__dirname, 'partie.json') : opts.saveFile;

  const game = VFGame.create({ ROLES, PRIORITY, pendingMs: opts.pendingMs });
  let G = load();
  let publicUrl = null;
  const qrCache = new Map();

  function load() {
    try {
      if (saveFile) return game.normalize(JSON.parse(fs.readFileSync(saveFile, 'utf8')));
    } catch (e) { /* pas de sauvegarde : nouvelle partie */ }
    return game.normalize(null);
  }

  // Sauvegarde reguliere pour reprendre la partie si le serveur redemarre.
  let saveTimer = null;
  function persist() {
    if (!saveFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const o = {};
      game.SHARED_KEYS.forEach((k) => { o[k] = G[k]; });
      const tmp = saveFile + '.tmp';
      fs.writeFile(tmp, JSON.stringify(o), (err) => {
        if (!err) fs.rename(tmp, saveFile, () => {});
      });
    }, 300);
  }

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));

  const pageData = getPageData({ hosted: true });
  app.get('/', (req, res) => res.render('jeu', pageData));
  app.get('/jeu', (req, res) => res.redirect('/'));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

  function stateMsg() {
    return JSON.stringify({ t: 'state', state: game.view(G), now: Date.now() });
  }
  function broadcast() {
    const msg = stateMsg();
    wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(stateMsg());
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'sync') { ws.send(stateMsg()); return; }
      if (msg.t !== 'act') return;
      let result;
      try {
        result = game.apply(G, msg.action);
      } catch (e) {
        console.error(e);
        result = { err: 'error' };
      }
      if (result.changed) { persist(); broadcast(); }
      ws.send(JSON.stringify({ t: 'res', id: msg.id, result }));
    });
  });

  // Annonce les morts en attente (pouvoirs) des que leur heure est venue.
  const ticker = setInterval(() => {
    if (game.tick(G)) { persist(); broadcast(); }
  }, 500);
  ticker.unref();

  // Coupe les connexions mortes (telephone endormi, wifi perdu...).
  const heartbeat = setInterval(() => {
    wss.clients.forEach((c) => {
      if (!c.isAlive) { c.terminate(); return; }
      c.isAlive = false;
      c.ping();
    });
  }, 25000);
  heartbeat.unref();

  // ---- Page /hote : adresses a donner aux joueurs (reservee au PC qui heberge) ----
  function ownAddresses() {
    const set = new Set(['127.0.0.1', '::1']);
    Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((i) => set.add(i.address)));
    return set;
  }
  function isHostRequest(req) {
    // Une requete venue du tunnel arrive aussi de 127.0.0.1, mais porte des en-tetes de proxy.
    if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false;
    const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return ownAddresses().has(addr);
  }
  function onlyHost(req, res, next) {
    if (isHostRequest(req)) return next();
    res.status(403).send('Réservé à l\'ordinateur qui héberge la partie.');
  }

  async function qrFor(url) {
    if (!qrCache.has(url)) {
      qrCache.set(url, await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#100e17', light: '#ffffff' } }));
    }
    return qrCache.get(url);
  }

  async function addresses() {
    const list = [];
    if (publicUrl) list.push({ label: 'Partout (internet)', note: 'Fonctionne sur n\'importe quel réseau, wifi ou 4G.', url: publicUrl });
    Object.entries(os.networkInterfaces()).forEach(([name, ifaces]) => (ifaces || []).forEach((i) => {
      if (i.family === 'IPv4' && !i.internal) {
        list.push({ label: `Même réseau · ${name}`, note: 'Seulement pour les téléphones sur le même wifi que l\'ordinateur (essaie celle du Wi-Fi).', url: `http://${i.address}:${port}` });
      }
    }));
    // D'abord l'adresse internet (marche partout), puis celle du Wi-Fi, puis les autres cartes reseau.
    const rank = (a) => (a.url === publicUrl ? 0 : /wi-?fi|wlan|sans fil/i.test(a.label) ? 1 : 2);
    list.sort((a, b) => rank(a) - rank(b));
    for (const a of list) a.qr = await qrFor(a.url);
    return list;
  }

  app.get('/hote', onlyHost, (req, res) => res.render('hote'));
  app.get('/hote/info', onlyHost, async (req, res) => {
    res.json({
      clients: [...wss.clients].filter((c) => c.readyState === 1).length,
      players: G.players.length,
      count: G.count,
      phase: G.phase,
      addresses: await addresses(),
      tunnel: publicUrl ? 'on' : 'off'
    });
  });
  app.post('/hote/reset', onlyHost, (req, res) => {
    game.apply(G, { type: 'new-game' });
    persist();
    broadcast();
    res.redirect('/hote');
  });

  return {
    app,
    server,
    game,
    wss,
    state: () => G,
    setPublicUrl(url) { publicUrl = url; },
    listen(cb) { server.listen(port, cb); },
    close(cb) { clearInterval(heartbeat); clearInterval(ticker); wss.clients.forEach((c) => c.terminate()); server.close(cb); }
  };
}

module.exports = { createHost };

if (require.main === module) {
  const host = createHost();
  host.listen(() => {
    const port = process.env.PORT || 3000;
    console.log(`Village et Fantaisy est lance sur http://localhost:${port}`);
    console.log(`Adresses a donner aux joueurs : http://localhost:${port}/hote`);
  });
}
