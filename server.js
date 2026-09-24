const path = require('path');
const express = require('express');
const { getPageData } = require('./page');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Le jeu tourne entierement dans le navigateur (etat dans localStorage) : le
// serveur ne fait que servir la page, le catalogue des roles et les blasons.
const pageData = getPageData();

app.get('/', (req, res) => {
  res.render('jeu', pageData);
});

app.get('/jeu', (req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Village et Fantaisy est lance sur http://localhost:${PORT}`);
});
