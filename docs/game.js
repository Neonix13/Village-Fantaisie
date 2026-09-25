// Regles du jeu : etat partage + actions. Pur (aucun DOM), utilise a la fois par le navigateur
// (mode un seul telephone) et par server.js (partie hebergee sur le PC, plusieurs telephones).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VFGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Champs de la partie partagee entre tous les telephones. `deck` reste chez l'hote.
  var SHARED_KEYS = ['phase', 'count', 'custom', 'boxes', 'deck', 'players', 'pr', 'fee', 'spy', 'hl', 'winner', 'conv', 'suc', 'lg', 'start', 'pend', 'ann', 'ask', 'seq', 'rev'];
  var CAMPS = ['royaume', 'vilains', 'autres'];
  // La Succube ne peut mettre fin a la vie de sa cible que 20 minutes apres l'avoir choisie.
  var SUC_DELAY_MS = 20 * 60000;
  // Le Loup-garou peut devorer un joueur une fois toutes les 40 minutes, la premiere fois
  // seulement apres 20 minutes de jeu (depuis le debut de la partie, pas le minuteur du Herault).
  var LG_DELAY_MS = 40 * 60000;
  var LG_FIRST_DELAY_MS = 20 * 60000;
  // Une mort provoquee par un pouvoir (Loup-garou, Succube) n'est annoncee aux autres joueurs
  // qu'une minute apres la demande, pour qu'on ne devine pas qui vient d'agir.
  var PENDING_MS = 60000;
  var CAUSE_IDS = ['devore', 'brule', 'asphyxie', 'pendu', 'empoisonne'];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function create(cfg) {
    var ROLES = cfg.ROLES;
    var PRIORITY = cfg.PRIORITY;
    var random = cfg.random || Math.random;
    var now = cfg.now || Date.now;
    var pendingMs = cfg.pendingMs === undefined ? PENDING_MS : cfg.pendingMs;

    function isRole(id) { return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ROLES, id); }

    function shuffleArr(arr) {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(random() * (i + 1));
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
      return arr;
    }

    function countsOf(arr) {
      var m = {};
      arr.forEach(function (id) { m[id] = (m[id] || 0) + 1; });
      return m;
    }
    function sumCounts(c) {
      return Object.keys(c).reduce(function (n, id) { return n + c[id]; }, 0);
    }
    function expandCounts(c) {
      var deck = [];
      Object.keys(c).forEach(function (id) { for (var i = 0; i < c[id]; i++) deck.push(id); });
      return deck;
    }
    // Liste par defaut : tous les personnages du jeu (quantites de PRIORITY dans roles.js).
    function defaultPool() { return countsOf(PRIORITY); }
    function dealtIds() { return Object.keys(ROLES).filter(function (id) { return !ROLES[id].notDealt; }); }

    function validateCounts(c) {
      if (sumCounts(c) < 1) return 'Ajoute au moins un personnage.';
      if (c.soldat > 0 && !(c.roi > 0)) return 'Le Soldat nécessite un Roi.';
      if (c.diable > 0 && !(c.demon > 0)) return 'Le Diable nécessite au moins un Démon.';
      return '';
    }

    // Tire n cartes au hasard dans la liste (completee par des Villageois si elle est
    // trop courte) en gardant les dependances Soldat->Roi et Diable->Demon.
    function drawFromPool(pool, n) {
      var deck = shuffleArr(expandCounts(pool)).slice(0, n);
      while (deck.length < n) deck.push('villageois');
      function fix(dep, need) {
        if (deck.indexOf(dep) === -1 || deck.indexOf(need) !== -1) return;
        var slot = deck.indexOf('villageois');
        if (slot === -1) {
          for (var i = 0; i < deck.length; i++) {
            if (['soldat', 'roi', 'diable', 'demon'].indexOf(deck[i]) === -1) { slot = i; break; }
          }
        }
        if (slot !== -1) deck[slot] = need;
        else deck = deck.map(function (id) { return id === dep ? 'villageois' : id; });
      }
      fix('soldat', 'roi');
      fix('diable', 'demon');
      return shuffleArr(deck);
    }

    function aliveIds(players) {
      var ids = [];
      players.forEach(function (p, i) { if (!p.dead) ids.push(i); });
      return ids;
    }
    function soldierIds(players) {
      return aliveIds(players).filter(function (i) { return players[i].role === 'soldat'; });
    }

    function defaultShared(count) {
      return {
        phase: 'setup',
        count: count || 8,
        custom: defaultPool(),
        boxes: {},
        deck: [],
        players: [],
        pr: [],
        fee: null,
        spy: {},
        hl: null,
        winner: null,
        conv: false,
        suc: {},
        lg: {},
        start: null,
        pend: [],
        ann: null,
        ask: [],
        seq: 0,
        rev: 0
      };
    }

    // Reconstruit une partie a partir d'une sauvegarde (y compris l'ancien format, ou tout
    // l'etat tenait dans un seul objet avec `screen` a la place de `phase`).
    function normalize(raw) {
      var G = defaultShared();
      if (!raw || typeof raw !== 'object') return G;
      SHARED_KEYS.forEach(function (k) { if (raw[k] !== undefined && raw[k] !== null) G[k] = raw[k]; });
      if (!raw.phase) {
        var s = raw.screen;
        G.phase = s === 'pioche' || s === 'reveal' ? 'pioche' : s === 'hub' || s === 'space' ? 'hub' : s === 'recap' ? 'recap' : 'setup';
      }
      return G;
    }

    // Ce que voient les telephones : tout sauf le paquet et les morts en attente d'annonce.
    function view(G) {
      var v = {};
      SHARED_KEYS.forEach(function (k) { if (k !== 'deck' && k !== 'pend') v[k] = G[k]; });
      return v;
    }

    // Le Diable meurt avec le dernier Demon en vie (sauf si la Fee le protege : protection consommee).
    // Renvoie la feuille a afficher, ou null si rien ne se passe.
    function devilFollowsDemons(G) {
      var demonAlive = aliveIds(G.players).some(function (i) { return G.players[i].role === 'demon'; });
      if (demonAlive) return null;
      var devils = aliveIds(G.players).filter(function (i) { return G.players[i].role === 'diable'; });
      if (!devils.length) return null;
      var idx = devils[0];
      if (G.fee === idx) {
        G.fee = null;
        return { kind: 'devil', pid: idx, saved: true };
      }
      devils.forEach(function (i) {
        G.players[i].dead = true;
        G.players[i].cause = 'lien';
      });
      return { kind: 'devil', pid: idx };
    }

    // Tue un joueur (cause donnee) et renvoie la feuille de suite a afficher (Diable, Soldats) ou null.
    function killPlayer(G, pid, cause) {
      var p = G.players[pid];
      p.dead = true;
      p.cause = cause;
      if (p.role === 'demon') return devilFollowsDemons(G);
      if (p.role === 'roi' && soldierIds(G.players).length) return { kind: 'soldiers' };
      return null;
    }

    // Succube : une cible verrouillee tant qu'elle est en vie (une cible morte ou bannie se remplace),
    // sauf si la Succube a elle-meme mis fin a sa vie : plus jamais d'autre cible.
    function sucSucuba(G, a) {
      var by = +a.by;
      var s = G.players[by];
      return s && !s.dead && s.role === 'succube' ? by : -1;
    }
    function sucPick(G, a) {
      var by = sucSucuba(G, a);
      var t = G.players[+a.pid];
      if (by < 0 || !t || t.dead || +a.pid === by) return { err: 'unknown' };
      var e = G.suc[by];
      if (e && e.done) return { err: 'done' };
      if (e && G.players[e.t] && !G.players[e.t].dead) return { err: 'locked' };
      G.suc[by] = { t: +a.pid, done: false, at: now() };
      return {};
    }
    function sucKill(G, a) {
      var by = sucSucuba(G, a);
      var e = by < 0 ? null : G.suc[by];
      if (!e || e.done || !G.players[e.t] || G.players[e.t].dead) return { err: 'unknown' };
      var wait = (e.at || 0) + SUC_DELAY_MS - now();
      if (wait > 0) return { err: 'wait', remaining: wait };
      e.done = true; // meme si la Fee protege la cible a l'annonce, elle ne pourra plus changer de cible
      G.pend.push({ pid: e.t, cause: 'asphyxie', due: now() + pendingMs });
      return { pending: true, pid: e.t, delay: pendingMs };
    }

    // Loup-garou : devore un joueur vivant (declare mort, cause Devore). Le delai de 40 minutes
    // court des l'essai, meme si la Fee protege la victime.
    function lgKill(G, a) {
      var by = +a.by;
      var w = G.players[by];
      var t = G.players[+a.pid];
      if (!w || w.dead || w.role !== 'loup_garou' || !t || t.dead || +a.pid === by) return { err: 'unknown' };
      var e = G.lg[by];
      var wait = e ? e.at + LG_DELAY_MS - now() : (G.start || 0) + LG_FIRST_DELAY_MS - now();
      if (wait > 0) return { err: 'wait', remaining: wait };
      G.lg[by] = { at: now() };
      G.pend.push({ pid: +a.pid, cause: 'devore', due: now() + pendingMs, ask: true });
      return { pending: true, pid: +a.pid, delay: pendingMs };
    }

    function player(G, a) {
      var pid = +a.pid;
      return G.players[pid] ? G.players[pid] : null;
    }

    function run(G, a) {
      var p;
      switch (a.type) {
        case 'count':
          if (G.phase !== 'setup') return { err: 'phase' };
          G.count = clamp(G.count + (a.delta > 0 ? 1 : -1), 4, 30);
          return {};

        case 'custom-set':
          if (G.phase !== 'setup') return { err: 'phase' };
          var c = {};
          dealtIds().forEach(function (id) {
            var n = clamp(parseInt(a.counts && a.counts[id], 10) || 0, 0, 10);
            if (n > 0) c[id] = n;
          });
          var msg = validateCounts(c);
          if (msg) return { err: 'invalid', message: msg };
          G.custom = c;
          return {};
        case 'custom-reset':
          if (G.phase !== 'setup') return { err: 'phase' };
          G.custom = defaultPool();
          return {};
        case 'box-set':
          if (!isRole(a.role)) return { err: 'unknown' };
          var v = String(a.value === undefined ? '' : a.value).trim().slice(0, 6);
          if (v) G.boxes[a.role] = v; else delete G.boxes[a.role];
          return {};

        case 'start-pioche':
          if (G.phase !== 'setup') return { err: 'phase' };
          G.deck = drawFromPool(G.custom, G.count);
          G.players = []; G.pr = []; G.fee = null; G.spy = {}; G.hl = null; G.winner = null; G.conv = false; G.suc = {}; G.lg = {}; G.start = null; G.pend = []; G.ann = null; G.ask = [];
          G.phase = 'pioche';
          return {};
        case 'back-setup':
          if (G.phase !== 'pioche' || G.players.length) return { err: 'phase' };
          G.phase = 'setup';
          return {};
        case 'draw':
          if (G.phase !== 'pioche') return { err: 'phase' };
          var name = String(a.name || '').trim().slice(0, 24);
          if (!name) return { err: 'empty' };
          var lower = name.toLowerCase();
          if (G.players.some(function (q) { return q.name.toLowerCase() === lower; })) return { err: 'dup' };
          if (G.players.length >= G.count) return { err: 'full' };
          G.players.push({ name: name, role: G.deck[G.players.length], dead: false });
          return { idx: G.players.length - 1 };
        case 'to-hub':
          if (G.phase === 'hub') return {};
          if (G.phase !== 'pioche' || G.players.length < G.count) return { err: 'phase' };
          G.phase = 'hub';
          G.hl = G.hl || now();
          G.start = G.start || now();
          return {};

        case 'kill-attempt':
          if (G.phase !== 'hub') return { err: 'phase' };
          p = player(G, a);
          if (!p || p.dead) return { err: 'already' };
          // La protection de la Fee absorbe une elimination (une seule fois).
          if (G.fee === +a.pid) { G.fee = null; return { saved: true }; }
          return { needCause: true };
        case 'kill':
          if (G.phase !== 'hub') return { err: 'phase' };
          p = player(G, a);
          if (!p || p.dead) return { err: 'already' };
          if (CAUSE_IDS.indexOf(a.cause) === -1) return { err: 'unknown' };
          if (p.role === 'diable' && a.cause === 'pendu') return { err: 'devil' }; // le Diable ne meurt pas par le vote
          return { followUp: killPlayer(G, +a.pid, a.cause) };
        case 'revive':
          if (G.phase !== 'hub') return { err: 'phase' };
          p = player(G, a);
          if (!p || !p.dead) return { err: 'already' };
          p.dead = false;
          delete p.cause;
          return {};
        case 'pardon':
          if (G.phase !== 'hub') return { err: 'phase' };
          if (!player(G, a)) return { err: 'unknown' };
          G.hl = now(); G.fee = null; G.conv = false;
          return {};
        case 'ban-soldiers':
          if (G.phase !== 'hub') return { err: 'phase' };
          soldierIds(G.players).forEach(function (i) {
            G.players[i].dead = true;
            G.players[i].cause = 'bannissement';
          });
          return {};
        case 'vamp':
          if (G.phase !== 'hub') return { err: 'phase' };
          if (G.conv) return { err: 'used' };
          p = player(G, a);
          if (!p || p.dead || p.role === 'licorne' || p.role === 'rejeton_vampire') return { err: 'unknown' };
          if (p.role === 'fee') G.fee = null;
          p.role = 'rejeton_vampire';
          p.converted = true;
          G.conv = true;
          return {};
        case 'priest-pick':
          if (G.phase !== 'hub') return { err: 'phase' };
          if (G.pr.length >= 2 || !player(G, a)) return { err: 'unknown' };
          if (G.pr.indexOf(+a.pid) === -1) G.pr.push(+a.pid);
          return {};
        case 'fee-pick':
          if (G.phase !== 'hub') return { err: 'phase' };
          if (!player(G, a)) return { err: 'unknown' };
          G.fee = +a.pid;
          return {};
        case 'spy-pick':
          if (G.phase !== 'hub') return { err: 'phase' };
          if (!player(G, a) || !isRole(a.role)) return { err: 'unknown' };
          G.spy[+a.pid] = a.role;
          return {};
        case 'suc-pick':
          if (G.phase !== 'hub') return { err: 'phase' };
          return sucPick(G, a);
        case 'suc-kill':
          if (G.phase !== 'hub') return { err: 'phase' };
          return sucKill(G, a);
        case 'lg-kill':
          if (G.phase !== 'hub') return { err: 'phase' };
          return lgKill(G, a);
        case 'lg-verdict':
          if (G.phase !== 'hub') return { err: 'phase' };
          return lgVerdict(G, a);
        case 'reset-timer':
          if (G.phase !== 'hub') return { err: 'phase' };
          G.hl = now(); G.fee = null; G.conv = false;
          return {};

        case 'end':
          if (G.phase !== 'hub') return { err: 'phase' };
          G.phase = 'recap';
          return {};
        case 'recap-back':
          if (G.phase !== 'recap') return { err: 'phase' };
          G.phase = 'hub';
          return {};
        case 'set-winner':
          if (CAMPS.indexOf(a.camp) === -1) return { err: 'unknown' };
          G.winner = a.camp;
          return {};
        case 'new-game':
          var rev = G.rev, seq = G.seq;
          var fresh = defaultShared(G.count);
          Object.keys(fresh).forEach(function (k) { G[k] = fresh[k]; });
          G.rev = rev;
          G.seq = seq;
          return {};
      }
      return { err: 'unknown' };
    }

    // Annonce a tous les telephones (mort du Roi : proposition de bannir les Soldats).
    function announceFollowUp(G, follow) {
      if (follow && follow.kind === 'soldiers') G.ann = { id: ++G.seq, kind: 'soldiers' };
    }

    // Reponse a la question "porte-t-elle la marque du Loup-garou ?" posee a tous : oui = eliminee
    // (la Fee peut l'absorber), non = elle reste en vie. La premiere reponse compte.
    function lgVerdict(G, a) {
      var i = -1;
      for (var k = 0; k < G.ask.length; k++) if (G.ask[k].id === +a.id) i = k;
      if (i < 0) return { err: 'gone' };
      var q = G.ask.splice(i, 1)[0];
      var p = G.players[q.pid];
      if (!a.marked || !p || p.dead) return { survived: true, pid: q.pid };
      if (G.fee === q.pid) { G.fee = null; return { saved: true, pid: q.pid }; }
      announceFollowUp(G, killPlayer(G, q.pid, 'devore'));
      return { killed: true, pid: q.pid };
    }

    // Annonce les morts dont l'heure est venue (Fee : la protection absorbe la mort). Renvoie true
    // si la partie a change. Appele regulierement par l'hote, et avant chaque action.
    function tick(G) {
      var t = now();
      var pend = G.pend || [];
      if (!pend.some(function (e) { return e.due <= t; })) return false;
      var keep = [];
      pend.forEach(function (e) {
        if (e.due > t) { keep.push(e); return; }
        var p = G.players[e.pid];
        if (!p || p.dead) return;
        // Dévoration : la victime est annoncee, la marque est verifiee par les joueurs.
        if (e.ask) { G.ask = G.ask || []; G.ask.push({ id: ++G.seq, pid: e.pid }); return; }
        if (G.fee === e.pid) { G.fee = null; return; }
        announceFollowUp(G, killPlayer(G, e.pid, e.cause));
      });
      G.pend = keep;
      G.rev = (G.rev || 0) + 1;
      return true;
    }

    // Applique une action a la partie (mutation en place). Renvoie { ok: true, ... } ou { err };
    // `changed` : la partie a change (meme si l'action est refusee, une mort a pu etre annoncee).
    function apply(G, a) {
      if (!a || typeof a.type !== 'string') return { err: 'unknown' };
      var before = tick(G);
      var r = run(G, a);
      var after = tick(G);
      if (!r.err) { r.ok = true; G.rev = (G.rev || 0) + 1; }
      r.changed = !r.err || before || after;
      return r;
    }

    return {
      SHARED_KEYS: SHARED_KEYS,
      SUC_DELAY_MS: SUC_DELAY_MS,
      LG_DELAY_MS: LG_DELAY_MS,
      LG_FIRST_DELAY_MS: LG_FIRST_DELAY_MS,
      countsOf: countsOf,
      sumCounts: sumCounts,
      expandCounts: expandCounts,
      defaultPool: defaultPool,
      dealtIds: dealtIds,
      validateCounts: validateCounts,
      drawFromPool: drawFromPool,
      aliveIds: aliveIds,
      soldierIds: soldierIds,
      defaultShared: defaultShared,
      normalize: normalize,
      view: view,
      tick: tick,
      PENDING_MS: PENDING_MS,
      apply: apply
    };
  }

  return { create: create, SHARED_KEYS: SHARED_KEYS, SUC_DELAY_MS: SUC_DELAY_MS };
});
