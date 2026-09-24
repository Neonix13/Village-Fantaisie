// Genere les icones de l'app (PNG) a partir d'un dessin SVG : losange dore + couronne du Roi.
// Usage : npm run icons   (necessite `sharp`, installe en devDependency)
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const outIcons = path.join(root, 'public', 'icons');
const outAssets = path.join(root, 'assets');
fs.mkdirSync(outIcons, { recursive: true });
fs.mkdirSync(outAssets, { recursive: true });

// `scale` reduit le dessin pour l'icone "maskable" (Android en decoupe les bords).
function iconSvg(scale) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="glow" cx="50%" cy="38%" r="65%">
      <stop offset="0" stop-color="#2a2140"/>
      <stop offset="1" stop-color="#100e17"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#glow)"/>
  <g transform="translate(256 256) scale(${scale})">
    <g transform="rotate(45)">
      <rect x="-150" y="-150" width="300" height="300" fill="#17141f" stroke="#e3b25e" stroke-width="9"/>
      <rect x="-130" y="-130" width="260" height="260" fill="none" stroke="#e3b25e" stroke-opacity="0.4" stroke-width="3"/>
    </g>
    <g transform="scale(6) translate(-24 -26)" fill="#e3b25e">
      <path d="M8 34 L14 16 L22 26 L24 12 L26 26 L34 16 L40 34 Z"/>
      <rect x="8" y="34" width="32" height="6" rx="1"/>
    </g>
  </g>
</svg>`;
}

async function png(svg, size, file) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(file);
  console.log('ok', path.relative(root, file));
}

(async () => {
  const normal = iconSvg(1);
  const maskable = iconSvg(0.78);
  fs.writeFileSync(path.join(outAssets, 'icon.svg'), normal);
  await png(normal, 192, path.join(outIcons, 'icon-192.png'));
  await png(normal, 512, path.join(outIcons, 'icon-512.png'));
  await png(maskable, 512, path.join(outIcons, 'icon-maskable-512.png'));
  await png(normal, 180, path.join(outIcons, 'apple-touch-icon.png'));
  // Sources 1024 px pour l'outil d'icones Capacitor / les stores.
  await png(normal, 1024, path.join(outAssets, 'icon-only.png'));
  await png(maskable, 1024, path.join(outAssets, 'icon-foreground.png'));
  // Ecran de demarrage : fond de l'app + icone centree (outil @capacitor/assets).
  const splash = path.join(outAssets, 'splash.png');
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: '#100e17' } })
    .composite([{ input: await sharp(Buffer.from(normal)).resize(900, 900).png().toBuffer(), gravity: 'center' }])
    .png().toFile(splash);
  console.log('ok', path.relative(root, splash));
})();
