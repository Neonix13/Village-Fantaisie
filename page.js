const fs = require('fs');
const path = require('path');
const ejsLib = require('ejs');
const { ROLES, PRIORITY } = require('./roles');

// Donnees injectees dans views/jeu.ejs, partagees par le serveur local (server.js)
// et par le build du site statique (scripts/build-site.js). Les blasons SVG
// (views/partials/role_badge.ejs) sont pre-rendus ici car le client n'a pas de
// moteur de templates.
const roleBadgeTemplatePath = path.join(__dirname, 'views', 'partials', 'role_badge.ejs');

function getPageData(opts) {
  const template = fs.readFileSync(roleBadgeTemplatePath, 'utf8');
  const badges = {};
  Object.values(ROLES).forEach((role) => {
    badges[role.id] = ejsLib.render(template, { role, size: 'sm' }, { filename: roleBadgeTemplatePath });
  });
  return {
    rolesJson: JSON.stringify(ROLES),
    priorityJson: JSON.stringify(PRIORITY),
    badgesJson: JSON.stringify(badges),
    // true : la page est servie par server.js et se connecte a la partie de l'hote ; false : site statique (partie locale).
    hosted: !!(opts && opts.hosted)
  };
}

module.exports = { getPageData };
