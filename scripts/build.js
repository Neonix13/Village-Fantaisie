// Produit la version STATIQUE de l'app dans www/ (index.html + assets), sans serveur :
// c'est ce dossier que Capacitor embarque dans l'APK / l'appli iOS, et qu'on peut
// aussi deployer tel quel sur n'importe quel hebergement statique (HTTPS pour la PWA).
// Usage : npm run build
const fs = require('fs');
const path = require('path');
const ejsLib = require('ejs');
const { getPageData } = require('../page');

const root = path.join(__dirname, '..');
const www = path.join(root, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), www, { recursive: true });

ejsLib.renderFile(path.join(root, 'views', 'jeu.ejs'), getPageData(), (err, html) => {
  if (err) throw err;
  fs.writeFileSync(path.join(www, 'index.html'), html);
  console.log('Version statique generee dans www/');
});
