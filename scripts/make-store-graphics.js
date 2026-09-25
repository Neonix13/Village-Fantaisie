// Genere les visuels de la fiche Play Store : icone 512x512 et image de presentation 1024x500.
// Usage : npm run store-graphics   (necessite `sharp`)
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const out = path.join(root, 'assets', 'store');
fs.mkdirSync(out, { recursive: true });

const gold = '#e3b25e';

const featureSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
  <defs>
    <radialGradient id="glow" cx="72%" cy="45%" r="60%">
      <stop offset="0" stop-color="#2a2140"/>
      <stop offset="1" stop-color="#100e17"/>
    </radialGradient>
    <pattern id="lines" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="24" stroke="${gold}" stroke-opacity="0.07" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1024" height="500" fill="url(#glow)"/>
  <rect width="1024" height="500" fill="url(#lines)"/>

  <g transform="translate(790 250)">
    <g transform="rotate(45)">
      <rect x="-150" y="-150" width="300" height="300" fill="#17141f" stroke="${gold}" stroke-width="5"/>
      <rect x="-132" y="-132" width="264" height="264" fill="none" stroke="${gold}" stroke-opacity="0.4" stroke-width="2"/>
    </g>
    <g transform="scale(5.4) translate(-24 -26)" fill="${gold}">
      <path d="M8 34 L14 16 L22 26 L24 12 L26 26 L34 16 L40 34 Z"/>
      <rect x="8" y="34" width="32" height="6" rx="1"/>
    </g>
  </g>

  <g font-family="Segoe UI, Arial, sans-serif" font-weight="800">
    <text x="70" y="205" font-size="70" letter-spacing="6" fill="#f2eefb">VILLAGE</text>
    <text x="70" y="285" font-size="70" letter-spacing="6" fill="${gold}">&amp; FANTAISY</text>
  </g>
  <rect x="70" y="315" width="70" height="3" fill="${gold}"/>
  <text x="70" y="365" font-family="Segoe UI, Arial, sans-serif" font-size="27" fill="#a89dc4">Jeu de rôles cachés pour vos soirées</text>
  <text x="70" y="402" font-family="Segoe UI, Arial, sans-serif" font-size="27" fill="#a89dc4">Un seul téléphone suffit</text>
</svg>`;

(async () => {
  await sharp(Buffer.from(featureSvg)).flatten({ background: '#100e17' }).png().toFile(path.join(out, 'image-presentation-1024x500.png'));
  console.log('ok assets/store/image-presentation-1024x500.png');
  await sharp(path.join(root, 'public', 'icons', 'icon-512.png')).flatten({ background: '#100e17' }).png().toFile(path.join(out, 'icone-512x512.png'));
  console.log('ok assets/store/icone-512x512.png');
})();
