// Catalogue statique des roles du jeu.
// "known" (***) = le role est connu de tous des le depart.
// "special" identifie un pouvoir gere par public/jeu.js (priest_reveal, fee_protect, spy_notes, devil_omniscient, shaman_dead, succube_target, werewolf_devour).
// "notDealt" = jamais distribue au depart (etat de conversion en cours de partie).
// "needsBox" = le role possede des objets ranges dans une boite numerotee ("boxItems" : ce qu'elle contient, affiche au joueur).
// "item" = objet fixe (roles connus de tous) : pas besoin de boite, toujours le meme objet.
const ROLES = {
  roi: {
    id: 'roi', name: 'Roi', camp: 'royaume', known: true, special: null,
    description: "Peut gracier un joueur condamné par le vote du village.",
    item: 'La couronne'
  },
  herault: {
    id: 'herault', name: 'Hérault', camp: 'royaume', known: true, special: null,
    description: "Organise les votes à sa guise, réunit les joueurs et fait le décompte.",
    item: 'Le cor'
  },
  chaman: {
    id: 'chaman', name: 'Chaman', camp: 'royaume', known: false, special: 'shaman_dead',
    description: "Connaît l'identité des joueurs morts pendant la partie."
  },
  villageois: {
    id: 'villageois', name: 'Villageois', camp: 'royaume', known: false, special: null,
    description: "Pas de pouvoir particulier."
  },
  soldat: {
    id: 'soldat', name: 'Soldat', camp: 'royaume', known: false, special: null,
    description: "Si le Roi meurt, les Soldats sont révélés et bannis du jeu (considérés morts)."
  },
  licorne: {
    id: 'licorne', name: 'Licorne', camp: 'royaume', known: false, special: null,
    description: "Si elle est tuée par un être maléfique, elle l'emporte avec lui."
  },
  fee: {
    id: 'fee', name: 'Fée', camp: 'royaume', known: false, special: 'fee_protect',
    description: "Peut donner un jeton de bénédiction à un joueur pour le protéger d'une mort ou d'une transformation jusqu'au prochain vote."
  },
  pretre: {
    id: 'pretre', name: 'Prêtre', camp: 'royaume', known: false, special: 'priest_reveal',
    description: "Peut découvrir le rôle de 2 personnes dans la partie."
  },
  diable: {
    id: 'diable', name: 'Diable', camp: 'vilains', known: true, special: 'devil_omniscient',
    description: "Ne peut pas être tué lors des votes et n'a pas de voix. Connaît les rôles de tout le monde. Meurt si les Démons meurent.",
    item: 'Les cornes'
  },
  demon: {
    id: 'demon', name: 'Démon', camp: 'vilains', known: false, special: null,
    description: "Si un joueur accepte une drogue offerte par un Démon (alcool, cigarette, cannabis), le Démon peut choisir de l'éliminer."
  },
  vampire: {
    id: 'vampire', name: 'Vampire', camp: 'vilains', known: false, special: null,
    description: "Peut convertir un autre joueur en Rejeton vampire (sauf la Licorne)."
  },
  sorciere: {
    id: 'sorciere', name: 'Sorcière', camp: 'vilains', known: false, special: null,
    description: "Peut empoisonner un verre (potion au piment oiseau) ; le joueur qui boit dedans est tué sur le coup.",
    needsBox: true
  },
  rejeton_vampire: {
    id: 'rejeton_vampire', name: 'Rejeton vampire', camp: 'vilains', known: false, special: null,
    description: "Transformé par un vampire : perd ses anciens pouvoirs et rejoint le camp du mal.",
    notDealt: true
  },
  loup_garou: {
    id: 'loup_garou', name: 'Loup-garou', camp: 'vilains', known: false, special: 'werewolf_devour',
    description: "Peut dévorer un autre joueur, une fois toutes les 40 minutes (la première fois après 20 minutes de jeu). Une minute plus tard, la victime n'est éliminée que si elle porte une gommette rouge posée par le Loup-garou, à récupérer dans sa boîte.",
    needsBox: true,
    boxItems: 'des gommettes rouges'
  },
  succube: {
    id: 'succube', name: 'Succube', camp: 'vilains', known: false,
    special: 'succube_target',
    description: "Choisit une cible qu'elle ne peut plus changer tant que celle-ci est en vie. Elle peut mettre fin à sa vie, mais pas avant 20 minutes, et ne pourra alors plus choisir d'autre cible. La cible sait qu'elle est ciblée."
  },
  voleur: {
    id: 'voleur', name: 'Voleur', camp: 'autres', known: false, special: null,
    description: "Gagne s'il a en poche un objet appartenant à chaque joueur encore en vie."
  },
  espion: {
    id: 'espion', name: 'Espion', camp: 'autres', known: false, special: 'spy_notes',
    description: "Note en secret le rôle de tous les joueurs. S'il devine sans erreur le rôle de 6 joueurs à la fin de la partie, il devient le seul gagnant."
  }
};

// Liste de personnages possibles par defaut (quantites incluses : Villageois, Soldat et
// Demon en double). Utilisee par public/jeu.js comme paquet de depart, dans lequel
// les cartes de la partie sont tirees au hasard.
const PRIORITY = [
  'roi', 'diable', 'herault', 'loup_garou', 'chaman',
  'villageois', 'villageois',
  'sorciere', 'vampire', 'pretre', 'fee', 'licorne', 'succube',
  'soldat', 'soldat',
  'demon', 'demon',
  'voleur', 'espion'
];

module.exports = { ROLES, PRIORITY };
