// Catalogue statique des roles du jeu.
// "known" (***) = le role est connu de tous des le depart.
// "special" identifie un comportement particulier gere par le serveur.
// "notDealt" = jamais distribue au depart (etat de conversion en cours de partie).
// "needsBox" = le role possede des objets et apparait dans l'editeur de boites du MJ.
// "item" = objet fixe (roles connus de tous) : pas besoin de boite, toujours le meme objet.
const ROLES = {
  roi: {
    id: 'roi', name: 'Roi', camp: 'royaume', known: true, special: null,
    description: "Peut gracier un joueur condamne par le vote du village.",
    item: 'La couronne'
  },
  herault: {
    id: 'herault', name: 'Herault', camp: 'royaume', known: true, special: null,
    description: "Organise les votes a sa guise, reunit les joueurs et fait le decompte.",
    item: 'Le cor'
  },
  chaman: {
    id: 'chaman', name: 'Chaman', camp: 'royaume', known: true, special: null,
    description: "Le seul a pouvoir parler avec les morts, en prive ou ouvertement.",
    item: 'Le miroir'
  },
  villageois: {
    id: 'villageois', name: 'Villageois', camp: 'royaume', known: false, special: null,
    description: "Pas de pouvoir particulier."
  },
  soldat: {
    id: 'soldat', name: 'Soldat', camp: 'royaume', known: false, special: null,
    description: "Si le Roi meurt, les Soldats sont reveles et bannis du jeu (consideres morts)."
  },
  licorne: {
    id: 'licorne', name: 'Licorne', camp: 'royaume', known: false, special: null,
    description: "Si elle est tuee par un etre malefique, elle l'emporte avec lui."
  },
  fee: {
    id: 'fee', name: 'Fee', camp: 'royaume', known: false, special: 'fee_protect',
    description: "Peut donner un jeton de benediction a un joueur pour le proteger d'une mort ou d'une transformation jusqu'au prochain vote."
  },
  pretre: {
    id: 'pretre', name: 'Pretre', camp: 'royaume', known: false, special: 'priest_reveal',
    description: "Peut decouvrir le role de 2 personnes dans la partie."
  },
  diable: {
    id: 'diable', name: 'Diable', camp: 'vilains', known: true, special: 'devil_omniscient',
    description: "Ne peut pas etre tue lors des votes et n'a pas de voix. Connait les roles de tout le monde. Meurt si les Demons meurent.",
    item: 'Les cornes'
  },
  demon: {
    id: 'demon', name: 'Demon', camp: 'vilains', known: false, special: null,
    description: "Si un joueur accepte une drogue offerte par un Demon (alcool, cigarette, cannabis), le Demon peut choisir de l'eliminer."
  },
  vampire: {
    id: 'vampire', name: 'Vampire', camp: 'vilains', known: false, special: null,
    description: "Peut convertir un autre joueur en Rejeton vampire (sauf la Licorne)."
  },
  sorciere: {
    id: 'sorciere', name: 'Sorciere', camp: 'vilains', known: false, special: null,
    description: "Peut empoisonner un verre (potion au piment oiseau) ; le joueur qui boit dedans est tue sur le coup.",
    needsBox: true
  },
  rejeton_vampire: {
    id: 'rejeton_vampire', name: 'Rejeton vampire', camp: 'vilains', known: false, special: null,
    description: "Transforme par un vampire : perd ses anciens pouvoirs et rejoint le camp du mal.",
    notDealt: true
  },
  loup_garou: {
    id: 'loup_garou', name: 'Loup-garou', camp: 'vilains', known: false, special: null,
    description: "Peut devorer un autre joueur."
  },
  succube: {
    id: 'succube', name: 'Succube', camp: 'vilains', known: false, special: null,
    description: "Choisit un joueur qui doit lui obeir. S'il refuse, il meurt et la Succube choisit une autre victime. Si la Succube meurt, sa victime meurt aussi."
  },
  voleur: {
    id: 'voleur', name: 'Voleur', camp: 'autres', known: false, special: null,
    description: "Gagne s'il a en poche un objet appartenant a chaque joueur encore en vie."
  },
  espion: {
    id: 'espion', name: 'Espion', camp: 'autres', known: false, special: 'spy_notes',
    description: "Note en secret le role de tous les joueurs. S'il devine sans erreur le role de 6 joueurs a la fin de la partie, il devient le seul gagnant."
  }
};

// Ordre de priorite utilise pour composer le deck : les roles les plus
// structurants du jeu d'abord, pour qu'ils soient toujours presents meme
// en petit comite. Les entrees en double correspondent aux roles a 2
// exemplaires (Soldat, Demon). Le Villageois de base (x2) est inclus ici ;
// tout joueur supplementaire au-dela de cette liste recoit un Villageois.
const PRIORITY = [
  'roi', 'diable', 'herault', 'loup_garou', 'chaman',
  'villageois', 'villageois',
  'sorciere', 'vampire', 'pretre', 'fee', 'licorne', 'succube',
  'soldat', 'soldat',
  'demon', 'demon',
  'voleur', 'espion'
];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Compose puis melange le deck de roles pour `playerCount` joueurs.
function buildDeck(playerCount) {
  const deck = PRIORITY.slice(0, playerCount);
  while (deck.length < playerCount) {
    deck.push('villageois');
  }
  return shuffle(deck);
}

// Roles pour lesquels le mode simplifie propose un compteur (0, 1, 2, 3...)
// plutot qu'une simple case a cocher : la quantite par defaut suggeree est
// x2, mais ce n'est pas une regle figee (le MJ peut en vouloir 1, 3...).
const PAIR_ROLES = new Set(['soldat', 'demon']);

// Compose un deck "mode simplifie" : `guaranteedCounts` donne le nombre
// exact voulu pour chaque role explicitement precise (0 = absent), puis on
// complete au hasard parmi les Vilains restants (1 exemplaire par role
// pioche) jusqu'a atteindre `villainTarget`, et le reste des places est
// comble par des Villageois. Renvoie `null` si les roles garantis + vilains
// demandes depassent `playerCount`.
function buildCustomDeck({ playerCount, guaranteedCounts, villainTarget }) {
  const deck = [];
  const guaranteedSet = new Set();

  Object.entries(guaranteedCounts || {}).forEach(([roleId, count]) => {
    if (!ROLES[roleId] || ROLES[roleId].notDealt) return;
    const n = Math.max(0, Math.min(10, count || 0));
    if (n > 0) guaranteedSet.add(roleId);
    for (let i = 0; i < n; i++) deck.push(roleId);
  });

  const villainsSoFar = deck.filter((id) => ROLES[id].camp === 'vilains').length;
  let remainingVillainTarget = villainTarget - villainsSoFar;

  if (remainingVillainTarget > 0) {
    const candidateVillainIds = shuffle(Object.values(ROLES)
      .filter((r) => r.camp === 'vilains' && !r.notDealt && !guaranteedSet.has(r.id))
      .map((r) => r.id));

    for (const roleId of candidateVillainIds) {
      if (remainingVillainTarget <= 0) break;
      deck.push(roleId);
      remainingVillainTarget -= 1;
    }
  }

  // Regles de dependance : Soldat necessite un Roi, Diable necessite au
  // moins un Demon (pas forcement 2). On complete automatiquement plutot
  // que d'echouer, sauf si ca ne rentre plus dans playerCount (verifie
  // juste apres).
  if (deck.includes('soldat') && !deck.includes('roi')) {
    deck.push('roi');
  }
  if (deck.includes('diable') && !deck.includes('demon')) {
    deck.push('demon');
  }

  if (deck.length > playerCount) {
    return null;
  }

  while (deck.length < playerCount) {
    deck.push('villageois');
  }

  return shuffle(deck);
}

module.exports = { ROLES, PRIORITY, PAIR_ROLES, buildDeck, buildCustomDeck, shuffle };
