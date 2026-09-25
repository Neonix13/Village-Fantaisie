// Lance le serveur ET un tunnel Cloudflare : les joueurs peuvent rejoindre la partie depuis
// n'importe quel reseau (wifi different, 4G) avec l'adresse https://...trycloudflare.com affichee
// sur http://localhost:3000/hote. Rien n'est stocke chez Cloudflare, le tunnel ne fait que relayer.
// Necessite le programme cloudflared (une seule fois : winget install --id Cloudflare.cloudflared).
const { spawn } = require('child_process');
const { createHost } = require('../server');

const port = process.env.PORT || 3000;
const host = createHost({ port });

host.listen(() => {
  console.log(`Serveur lance sur http://localhost:${port}`);
  console.log(`Adresses a donner aux joueurs : http://localhost:${port}/hote`);

  const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  function onOutput(chunk) {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
    if (match) {
      host.setPublicUrl(match[0]);
      console.log(`Adresse publique : ${match[0]}`);
    }
  }
  tunnel.stdout.on('data', onOutput);
  tunnel.stderr.on('data', onOutput);

  tunnel.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.log('cloudflared est introuvable : seul le wifi local fonctionne.');
      console.log('Installe-le une fois avec : winget install --id Cloudflare.cloudflared (puis relance npm run public).');
    } else {
      console.log('Tunnel impossible :', err.message);
    }
  });
  tunnel.on('exit', () => {
    host.setPublicUrl(null);
    console.log('Tunnel ferme : seul le wifi local fonctionne.');
  });

  const stop = () => { tunnel.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => tunnel.kill());
});
