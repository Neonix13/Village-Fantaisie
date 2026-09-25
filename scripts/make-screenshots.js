// Genere les captures d'ecran de la fiche Play Store (1080x2160) avec Chrome sans interface.
// Une partie de demonstration (prenoms inventes) est injectee dans le localStorage avant le chargement.
// Usage : npm run screenshots   (Chrome doit etre installe)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const ejsLib = require('ejs');
const { getPageData } = require('../page');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'assets', 'store', 'captures');
const PORT = 3999;
const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('Chrome ou Edge introuvable');

const KEY = 'vf-partie-v1';
const DEMO = [
  ['Léa', 'roi'], ['Tom', 'villageois'], ['Inès', 'fee'], ['Hugo', 'loup_garou'],
  ['Camille', 'pretre'], ['Noé', 'herault'], ['Jade', 'sorciere'], ['Yanis', 'diable']
];
const players = DEMO.map(([name, role]) => ({ name, role, dead: false }));
players[3].dead = true; players[3].cause = 'devore';

function seed(state) {
  return `try{localStorage.setItem(${JSON.stringify(KEY)},JSON.stringify(Object.assign(${JSON.stringify(state)},{hl:Date.now()-4*60000})));}catch(e){}`;
}
const click = (sel, delay) => `setTimeout(function(){var e=document.querySelector(${JSON.stringify(sel)});if(e)e.click();},${delay});`;

const scenes = {
  '1-accueil': { seed: seed({ screen: 'onboard', ob: 0 }), actions: '' },
  '2-mise-en-place': { seed: seed({ screen: 'setup', count: 8 }), actions: '' },
  '3-carte-revelee': {
    seed: seed({ screen: 'pioche', count: 8, deck: ['sorciere', 'roi', 'fee', 'villageois', 'pretre', 'loup_garou', 'herault', 'diable'], players: [] }),
    actions: `setTimeout(function(){var i=document.getElementById('vf-name');i.value='Léa';},300);` +
      click('[data-action=draw]', 600) + click('[data-action=flip]', 2200)
  },
  '4-village': { seed: seed({ screen: 'hub', tab: 'village', count: 8, players }), actions: '' },
  '5-espace-secret': {
    seed: seed({ screen: 'hub', tab: 'secret', count: 8, players }),
    actions: click('[data-action=ask-space][data-arg="5"]', 400) + click('[data-action=open-space]', 900)
  },
  '6-fin-de-partie': { seed: seed({ screen: 'recap', count: 8, players, winner: 'royaume' }), actions: '' }
};

const app = express();
app.use(express.static(path.join(root, 'public')));
const pageData = getPageData();
app.get('/', (req, res) => {
  const scene = scenes[req.query.scene];
  ejsLib.renderFile(path.join(root, 'views', 'jeu.ejs'), pageData, (err, html) => {
    if (err) return res.status(500).send(String(err));
    res.send(html.replace('<script src="/jeu.js"></script>',
      `<script>${scene.seed}</script><script src="/jeu.js"></script><script>${scene.actions}</script>`));
  });
});

fs.mkdirSync(outDir, { recursive: true });
const server = app.listen(PORT, () => {
  if (process.env.SERVE_ONLY) { console.log('Serveur de demo sur http://localhost:' + PORT + '/?scene=<nom>'); return; }
  for (const name of Object.keys(scenes)) {
    const file = path.join(outDir, `${name}.png`);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-shot-'));
    const r = spawnSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      `--user-data-dir=${profile}`, '--window-size=480,960', '--force-device-scale-factor=2.25',
      '--virtual-time-budget=8000', `--screenshot=${file}`,
      `http://localhost:${PORT}/?scene=${name}`
    ], { encoding: 'utf8', timeout: 60000 });
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(fs.existsSync(file) ? 'ok' : 'ECHEC', path.relative(root, file), r.status === 0 ? '' : `(code ${r.status})`);
  }
  server.close();
});
