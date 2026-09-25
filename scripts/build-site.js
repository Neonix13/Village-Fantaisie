// Genere la version STATIQUE du jeu dans docs/ (index.html + assets), publiable telle
// quelle sur GitHub Pages : Settings > Pages > branche master, dossier /docs.
// Les liens de la page sont relatifs, donc le site marche aussi dans un sous-dossier
// (https://<compte>.github.io/<depot>/).
// Usage : npm run build:site   puis commiter docs/
const fs = require('fs');
const path = require('path');
const ejsLib = require('ejs');
const { getPageData } = require('../page');

const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');

fs.rmSync(docs, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), docs, { recursive: true });
fs.writeFileSync(path.join(docs, '.nojekyll'), '');

ejsLib.renderFile(path.join(root, 'views', 'jeu.ejs'), getPageData(), (err, html) => {
  if (err) throw err;
  fs.writeFileSync(path.join(docs, 'index.html'), html);
  console.log('Site statique genere dans docs/');
});
