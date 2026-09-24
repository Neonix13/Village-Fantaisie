const fs = require('fs');
const path = require('path');
const ejsLib = require('ejs');
const { ROLES, PRIORITY } = require('./roles');

// Donnees injectees dans views/jeu.ejs (partagees par le serveur de dev et par
// scripts/build.js qui produit la version statique pour l'appli mobile).
// Les blasons SVG (views/partials/role_badge.ejs) sont pre-rendus ici car le
// client n'a pas de moteur de templates.
const roleBadgeTemplatePath = path.join(__dirname, 'views', 'partials', 'role_badge.ejs');

function getPageData() {
  const template = fs.readFileSync(roleBadgeTemplatePath, 'utf8');
  const badges = {};
  Object.values(ROLES).forEach((role) => {
    badges[role.id] = ejsLib.render(template, { role, size: 'sm' }, { filename: roleBadgeTemplatePath });
  });
  return {
    rolesJson: JSON.stringify(ROLES),
    priorityJson: JSON.stringify(PRIORITY),
    badgesJson: JSON.stringify(badges)
  };
}

module.exports = { getPageData };
