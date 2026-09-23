const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const ejsLib = require('ejs');
const db = require('./db');
const { ROLES, PRIORITY, PAIR_ROLES, buildDeck, buildCustomDeck, shuffle } = require('./roles');

const DEATH_CAUSES = [
  { id: 'devore', label: 'Devore (Loup-garou)' },
  { id: 'brule', label: 'Brule (Demon)' },
  { id: 'asphyxie', label: 'Asphyxie (Succube)' },
  { id: 'pendu', label: 'Pendu (vote)' },
  { id: 'empoisonne', label: 'Empoisonne (Sorciere)' }
];
const DEATH_CAUSE_LABELS = Object.fromEntries(DEATH_CAUSES.map((c) => [c.id, c.label]));
DEATH_CAUSE_LABELS.bannissement = 'Bannissement (mort du Roi)';

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

function genId(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function roleOrNull(roleId) {
  return ROLES[roleId] || null;
}

function dealableRoles() {
  return Object.values(ROLES).filter((r) => !r.notDealt);
}

function groupRolesByCamp() {
  const groups = { royaume: [], vilains: [], autres: [] };
  dealableRoles().forEach((r) => groups[r.camp].push(r));
  Object.values(groups).forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name)));
  return groups;
}

// --- Home -------------------------------------------------------------

app.get('/', (req, res) => {
  res.render('home');
});

// --- Mode "un seul telephone" (jeu) --------------------------------------

const roleBadgeTemplatePath = path.join(__dirname, 'views', 'partials', 'role_badge.ejs');

function renderRoleBadge(role) {
  const template = fs.readFileSync(roleBadgeTemplatePath, 'utf8');
  return ejsLib.render(template, { role, size: 'sm' }, { filename: roleBadgeTemplatePath });
}

app.get('/jeu', (req, res) => {
  const badges = {};
  dealableRoles().forEach((role) => { badges[role.id] = renderRoleBadge(role); });

  res.render('jeu', {
    rolesJson: JSON.stringify(ROLES),
    priorityJson: JSON.stringify(PRIORITY),
    badgesJson: JSON.stringify(badges)
  });
});

// --- Admin --------------------------------------------------------------

function loadPartyForAdmin(req, res, next) {
  const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.partyId);
  if (!party || party.admin_token !== req.params.adminToken) {
    return res.status(404).send('Partie introuvable.');
  }
  req.party = party;
  next();
}

// --- Etape 1 : nombre de joueurs -----------------------------------------

app.get('/admin/new', (req, res) => {
  res.render('admin_new', { error: null, expectedPlayers: '' });
});

app.post('/admin/new', (req, res) => {
  const n = parseInt(req.body.expected_players, 10);
  if (!Number.isInteger(n) || n < 1 || n > 60) {
    return res.render('admin_new', {
      error: 'Merci d\'indiquer un nombre de joueurs valide (1 a 60).',
      expectedPlayers: req.body.expected_players || ''
    });
  }

  const partyId = genId(6);
  const adminToken = genId(12);
  db.prepare(`
    INSERT INTO parties (id, created_at, admin_token, expected_players, deck_json, next_index, herald_signal_minutes, last_signal_at)
    VALUES (?, ?, ?, ?, '[]', 0, 30, ?)
  `).run(partyId, nowIso(), adminToken, n, nowIso());
  res.redirect(`/admin/${partyId}/${adminToken}/deck`);
});

// --- Etape 2 : personnalisation du deck -----------------------------------

function deckStepViewData(party, error, formValues) {
  const suggested = buildDeck(party.expected_players);
  const suggestedCounts = {};
  suggested.forEach((roleId) => { suggestedCounts[roleId] = (suggestedCounts[roleId] || 0) + 1; });
  const suggestedVillainTarget = suggested.filter((id) => ROLES[id].camp === 'vilains').length;

  return {
    party,
    error,
    rolesByCamp: groupRolesByCamp(),
    pairRoles: PAIR_ROLES,
    customCounts: (formValues && formValues.customCounts) || suggestedCounts,
    guaranteedRoleIds: (formValues && formValues.guaranteedRoleIds) || Object.keys(suggestedCounts),
    villainTarget: (formValues && formValues.villainTarget !== undefined) ? formValues.villainTarget : suggestedVillainTarget,
    mode: (formValues && formValues.mode) || 'simple'
  };
}

app.get('/admin/:partyId/:adminToken/deck', loadPartyForAdmin, (req, res) => {
  res.render('admin_deck', deckStepViewData(req.party, null, null));
});

app.post('/admin/:partyId/:adminToken/deck', loadPartyForAdmin, (req, res) => {
  const party = req.party;
  const mode = req.body.mode === 'detaille' ? 'detaille' : 'simple';
  let deck;

  if (mode === 'detaille') {
    deck = [];
    const customCounts = {};
    dealableRoles().forEach((role) => {
      const n = parseInt(req.body['count_' + role.id], 10);
      const count = Number.isInteger(n) && n > 0 ? n : 0;
      customCounts[role.id] = count;
      for (let i = 0; i < count; i++) deck.push(role.id);
    });
    let message = null;
    if (deck.length < 1) message = 'Ajoute au moins un role au deck.';
    else if (deck.length > 60) message = 'Le deck depasse 60 joueurs.';
    else if (customCounts.soldat > 0 && !(customCounts.roi > 0)) message = 'Soldat necessite au moins 1 Roi dans le deck.';
    else if (customCounts.diable > 0 && !(customCounts.demon > 0)) message = 'Diable necessite au moins 1 Demon dans le deck.';

    if (message) {
      return res.render('admin_deck', deckStepViewData(party, message, { mode, customCounts }));
    }
    shuffle(deck);
  } else {
    const guaranteedCounts = {};
    dealableRoles().forEach((role) => {
      if (PAIR_ROLES.has(role.id)) {
        const n = parseInt(req.body['count_' + role.id], 10);
        guaranteedCounts[role.id] = Number.isInteger(n) && n > 0 ? n : 0;
      } else {
        guaranteedCounts[role.id] = req.body['guarantee_' + role.id] === 'on' ? 1 : 0;
      }
    });
    const guaranteedRoleIds = Object.keys(guaranteedCounts).filter((id) => guaranteedCounts[id] > 0);
    const villainTarget = Math.max(0, parseInt(req.body.villain_target, 10) || 0);

    deck = buildCustomDeck({ playerCount: party.expected_players, guaranteedCounts, villainTarget });
    if (!deck) {
      return res.render('admin_deck', deckStepViewData(party,
        'Les personnages garantis (et/ou le nombre de vilains demande) depassent le nombre de joueurs.',
        { mode, customCounts: guaranteedCounts, guaranteedRoleIds, villainTarget }));
    }
  }

  db.prepare('UPDATE parties SET deck_json = ?, expected_players = ? WHERE id = ?')
    .run(JSON.stringify(deck), deck.length, party.id);
  res.redirect(`/admin/${party.id}/${party.admin_token}/boxes-step`);
});

// --- Etape 2bis : attribution des boites -----------------------------------

function rolesNeedingBoxFor(deck) {
  const present = new Set(deck);
  return dealableRoles().filter((r) => r.needsBox && present.has(r.id)).sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/admin/:partyId/:adminToken/boxes-step', loadPartyForAdmin, (req, res) => {
  const deck = JSON.parse(req.party.deck_json);
  const roles = rolesNeedingBoxFor(deck);
  if (roles.length === 0) {
    return res.redirect(`/pioche/${req.party.id}`);
  }
  const boxes = db.prepare('SELECT * FROM boxes WHERE party_id = ?').all(req.party.id);
  const boxByRole = {};
  boxes.forEach((b) => { boxByRole[b.role_id] = b.number; });
  res.render('admin_boxes_step', { party: req.party, roles, boxByRole });
});

app.post('/admin/:partyId/:adminToken/boxes-step', loadPartyForAdmin, (req, res) => {
  const deck = JSON.parse(req.party.deck_json);
  const roles = rolesNeedingBoxFor(deck);
  roles.forEach((role) => {
    const trimmed = (req.body['number_' + role.id] || '').trim();
    if (trimmed === '') {
      db.prepare('DELETE FROM boxes WHERE party_id = ? AND role_id = ?').run(req.party.id, role.id);
    } else {
      db.prepare(`
        INSERT INTO boxes (party_id, number, role_id) VALUES (?, ?, ?)
        ON CONFLICT(party_id, role_id) DO UPDATE SET number = excluded.number
      `).run(req.party.id, trimmed, role.id);
    }
  });
  res.redirect(`/pioche/${req.party.id}`);
});

app.get('/admin/:partyId/:adminToken', loadPartyForAdmin, (req, res) => {
  const party = req.party;
  const deck = JSON.parse(party.deck_json);

  res.render('admin_dashboard', {
    party, drawnCount: party.next_index, totalCount: deck.length
  });
});

app.post('/admin/:partyId/:adminToken/reset', loadPartyForAdmin, (req, res) => {
  db.prepare('DELETE FROM players WHERE party_id = ?').run(req.party.id);
  db.prepare('DELETE FROM boxes WHERE party_id = ?').run(req.party.id);
  db.prepare('DELETE FROM reveals WHERE party_id = ?').run(req.party.id);
  db.prepare('DELETE FROM parties WHERE id = ?').run(req.party.id);
  res.redirect('/admin/new');
});

// --- Bouton "Pouvoir" : acces a sa fiche perso par prenom ------------------

app.get('/admin/:partyId/:adminToken/pouvoir', loadPartyForAdmin, (req, res) => {
  res.render('admin_pouvoir', { party: req.party, error: null });
});

app.post('/admin/:partyId/:adminToken/pouvoir', loadPartyForAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const player = db.prepare('SELECT token FROM players WHERE party_id = ? AND name = ? COLLATE NOCASE')
    .get(req.party.id, name);
  if (!player) {
    return res.render('admin_pouvoir', { party: req.party, error: `Aucun joueur nomme "${name}".` });
  }
  res.redirect(`/moi/${player.token}`);
});

// --- Bouton "Liste des joueurs" : vivants / morts + declaration des morts -

app.get('/admin/:partyId/:adminToken/joueurs', loadPartyForAdmin, (req, res) => {
  const players = db.prepare('SELECT * FROM players WHERE party_id = ? ORDER BY name COLLATE NOCASE').all(req.party.id);
  res.render('admin_joueurs', {
    party: req.party,
    alivePlayers: players.filter((p) => p.alive),
    deadPlayers: players.filter((p) => !p.alive),
    deathCauses: DEATH_CAUSES,
    deathCauseLabels: DEATH_CAUSE_LABELS
  });
});

app.post('/admin/:partyId/:adminToken/players/:playerId/eliminate', loadPartyForAdmin, (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ? AND party_id = ?').get(req.params.playerId, req.party.id);
  if (!player) return res.status(404).json({ error: 'not found' });

  if (player.fee_protected) {
    db.prepare('UPDATE players SET fee_protected = 0 WHERE id = ?').run(player.id);
    return res.json({ saved: true, role_id: player.role_id });
  }

  const cause = req.body.cause;
  if (!DEATH_CAUSE_LABELS[cause]) return res.status(400).json({ error: 'cause invalide' });

  db.prepare('UPDATE players SET alive = 0, eliminated_at = ?, death_cause = ? WHERE id = ?')
    .run(nowIso(), cause, player.id);
  res.json({ alive: false, role_id: player.role_id, cause, causeLabel: DEATH_CAUSE_LABELS[cause] });
});

app.post('/admin/:partyId/:adminToken/players/:playerId/revive', loadPartyForAdmin, (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ? AND party_id = ?').get(req.params.playerId, req.party.id);
  if (!player) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE players SET alive = 1, eliminated_at = NULL, death_cause = NULL WHERE id = ?').run(player.id);
  res.json({ alive: true, role_id: player.role_id });
});

app.post('/admin/:partyId/:adminToken/eliminate-soldiers', loadPartyForAdmin, (req, res) => {
  db.prepare(`
    UPDATE players SET alive = 0, eliminated_at = ?, death_cause = 'bannissement'
    WHERE party_id = ? AND role_id = 'soldat' AND alive = 1
  `).run(nowIso(), req.party.id);
  res.json({ ok: true });
});

// --- Pioche (ecran partage dans la piece isolee) ------------------------

app.get('/pioche/:partyId', (req, res) => {
  const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.partyId);
  if (!party) return res.status(404).send('Partie introuvable.');
  const deck = JSON.parse(party.deck_json);
  res.render('pioche', { party, error: null, remaining: deck.length - party.next_index });
});

app.post('/pioche/:partyId', (req, res) => {
  const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.partyId);
  if (!party) return res.status(404).send('Partie introuvable.');

  const deck = JSON.parse(party.deck_json);
  const name = (req.body.name || '').trim();

  if (!name) {
    return res.render('pioche', { party, error: 'Merci d\'entrer un prenom.', remaining: deck.length - party.next_index });
  }
  if (party.next_index >= deck.length) {
    return res.render('pioche', { party, error: 'Tous les roles ont deja ete distribues.', remaining: 0 });
  }

  const existing = db.prepare('SELECT id FROM players WHERE party_id = ? AND name = ?').get(party.id, name);
  if (existing) {
    return res.render('pioche', { party, error: `${name} a deja pioche un role.`, remaining: deck.length - party.next_index });
  }

  const roleId = deck[party.next_index];
  const token = genId(12);

  db.prepare('UPDATE parties SET next_index = next_index + 1 WHERE id = ?').run(party.id);
  const info = db.prepare(`
    INSERT INTO players (party_id, name, role_id, token, alive, joined_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(party.id, name, roleId, token, nowIso());

  const box = db.prepare('SELECT number FROM boxes WHERE party_id = ? AND role_id = ?').get(party.id, roleId);

  res.render('reveal', {
    party, name, role: roleOrNull(roleId), boxNumber: box ? box.number : null, token
  });
});

// --- Page personnelle du joueur ------------------------------------------

function loadPlayerByToken(req, res, next) {
  const player = db.prepare('SELECT * FROM players WHERE token = ?').get(req.params.token);
  if (!player) return res.status(404).send('Joueur introuvable.');
  req.player = player;
  req.party = db.prepare('SELECT * FROM parties WHERE id = ?').get(player.party_id);
  next();
}

app.get('/moi/:token', loadPlayerByToken, (req, res) => {
  const player = req.player;
  const party = req.party;
  const role = roleOrNull(player.role_id);

  const box = db.prepare('SELECT number FROM boxes WHERE party_id = ? AND role_id = ?').get(party.id, player.role_id);

  let priestData = null;
  let devilData = null;
  let feeData = null;

  if (role.special === 'priest_reveal') {
    const revealCount = db.prepare('SELECT COUNT(*) AS c FROM reveals WHERE viewer_player_id = ?').get(player.id).c;
    const revealed = db.prepare(`
      SELECT t.name AS target_name, t.role_id AS target_role_id
      FROM reveals r JOIN players t ON t.id = r.target_player_id
      WHERE r.viewer_player_id = ?
      ORDER BY r.created_at
    `).all(player.id).map((r) => ({ name: r.target_name, role: roleOrNull(r.target_role_id) }));
    const candidates = db.prepare('SELECT id, name FROM players WHERE party_id = ? AND id != ? ORDER BY name')
      .all(party.id, player.id);
    priestData = { revealCount, remaining: Math.max(0, 2 - revealCount), revealed, candidates };
  }

  if (role.special === 'devil_omniscient') {
    devilData = db.prepare('SELECT name, role_id, alive FROM players WHERE party_id = ? ORDER BY name').all(party.id)
      .map((p) => ({ name: p.name, role: roleOrNull(p.role_id), alive: !!p.alive }));
  }

  if (role.special === 'fee_protect') {
    const protectedPlayer = db.prepare('SELECT name FROM players WHERE party_id = ? AND fee_protected = 1').get(party.id);
    const candidates = db.prepare('SELECT id, name FROM players WHERE party_id = ? ORDER BY name').all(party.id);
    feeData = { protectedName: protectedPlayer ? protectedPlayer.name : null, candidates };
  }

  res.render('moi', {
    party, player, role, box: box ? box.number : null, priestData, devilData, feeData
  });
});

app.post('/moi/:token/reveal', loadPlayerByToken, (req, res) => {
  const player = req.player;
  const role = roleOrNull(player.role_id);
  if (role.special !== 'priest_reveal') return res.status(403).send('Action non autorisee.');

  const revealCount = db.prepare('SELECT COUNT(*) AS c FROM reveals WHERE viewer_player_id = ?').get(player.id).c;
  if (revealCount >= 2) return res.redirect(`/moi/${player.token}`);

  const targetId = parseInt(req.body.target_player_id, 10);
  const target = db.prepare('SELECT id FROM players WHERE id = ? AND party_id = ?').get(targetId, player.party_id);
  if (!target) return res.status(400).send('Cible invalide.');

  db.prepare('INSERT INTO reveals (party_id, viewer_player_id, target_player_id, created_at) VALUES (?, ?, ?, ?)')
    .run(player.party_id, player.id, target.id, nowIso());

  res.redirect(`/moi/${player.token}`);
});

app.post('/moi/:token/protect', loadPlayerByToken, (req, res) => {
  const player = req.player;
  const role = roleOrNull(player.role_id);
  if (role.special !== 'fee_protect') return res.status(403).send('Action non autorisee.');

  const targetId = parseInt(req.body.target_player_id, 10);
  const target = db.prepare('SELECT id FROM players WHERE id = ? AND party_id = ?').get(targetId, player.party_id);
  if (!target) return res.status(400).send('Cible invalide.');

  db.prepare('UPDATE players SET fee_protected = 0 WHERE party_id = ?').run(player.party_id);
  db.prepare('UPDATE players SET fee_protected = 1 WHERE id = ?').run(target.id);

  res.redirect(`/moi/${player.token}`);
});

app.post('/moi/:token/notes', loadPlayerByToken, (req, res) => {
  const player = req.player;
  const role = roleOrNull(player.role_id);
  if (role.special !== 'spy_notes') return res.status(403).send('Action non autorisee.');
  db.prepare('UPDATE players SET notes = ? WHERE id = ?').run(req.body.notes || '', player.id);
  res.redirect(`/moi/${player.token}`);
});

app.post('/moi/:token/reset-timer', loadPlayerByToken, (req, res) => {
  const player = req.player;
  if (player.role_id !== 'herault') return res.status(403).send('Action non autorisee.');
  db.prepare('UPDATE players SET fee_protected = 0 WHERE party_id = ?').run(player.party_id);
  db.prepare('UPDATE parties SET last_signal_at = ? WHERE id = ?').run(nowIso(), player.party_id);
  res.redirect(`/moi/${player.token}`);
});

// --- Plateau public (vivants / morts) ------------------------------------

app.get('/plateau/:partyId', (req, res) => {
  const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.partyId);
  if (!party) return res.status(404).send('Partie introuvable.');
  const players = db.prepare('SELECT name, alive FROM players WHERE party_id = ? ORDER BY name').all(party.id);
  res.render('plateau', { party, players });
});

app.listen(PORT, () => {
  console.log(`Village et Fantaisy est lance sur http://localhost:${PORT}`);
});
