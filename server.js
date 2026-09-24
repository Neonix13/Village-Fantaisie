const fs = require('fs');
const path = require('path');
const express = require('express');
const ejsLib = require('ejs');
const { ROLES, PRIORITY } = require('./roles');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Le jeu tourne entierement dans le navigateur (etat dans localStorage) : le
// serveur ne fait que servir la page, le catalogue des roles et les blasons.
// Les blasons SVG (views/partials/role_badge.ejs) sont pre-rendus une fois ici
// car le client n'a pas de moteur de templates.
const roleBadgeTemplatePath = path.join(__dirname, 'views', 'partials', 'role_badge.ejs');
const roleBadgeTemplate = fs.readFileSync(roleBadgeTemplatePath, 'utf8');

const badges = {};
Object.values(ROLES).forEach((role) => {
  badges[role.id] = ejsLib.render(roleBadgeTemplate, { role, size: 'sm' }, { filename: roleBadgeTemplatePath });
});

const pageData = {
  rolesJson: JSON.stringify(ROLES),
  priorityJson: JSON.stringify(PRIORITY),
  badgesJson: JSON.stringify(badges)
};

app.get('/', (req, res) => {
  res.render('jeu', pageData);
});

app.get('/jeu', (req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Village et Fantaisy est lance sur http://localhost:${PORT}`);
});
