(function () {
  'use strict';

  var UI_KEY = 'vf-ui-v1';
  var LEGACY_KEY = 'vf-partie-v1'; // ancienne sauvegarde : tout l'etat dans un seul objet

  var ROLES = window.VF_ROLES || {};
  var PRIORITY = window.VF_PRIORITY || [];
  var BADGES = window.VF_BADGES || {};

  var CAMPS = ['royaume', 'vilains', 'autres'];
  var CAMP_LABEL = { royaume: 'Royaume', vilains: 'Vilains', autres: 'Autres' };
  var CAMP_COLOR = { royaume: 'var(--vf-royaume)', vilains: 'var(--vf-vilains)', autres: 'var(--vf-autres)' };
  var REVEAL_SECONDS = 60;

  // Les regles vivent dans game.js ; la partie (joueurs, roles, morts...) est partagee entre
  // tous les telephones connectes a la meme partie, seul l'ecran affiche est propre a chacun.
  var Game = VFGame.create({ ROLES: ROLES, PRIORITY: PRIORITY });
  var transport = window.VF_HOSTED ? VFNet.ws() : VFNet.local(Game);
  var ready = false;   // premier etat de la partie recu
  var link = 'connecting';
  var seenAsk = 0; // derniere question "porte-t-elle la marque ?" deja affichee sur ce telephone
  var seenAnn = 0; // derniere annonce (mort du Roi par un pouvoir) deja affichee sur ce telephone
  var MULTI = !!window.VF_HOSTED; // chacun son telephone (sinon : un seul telephone qui circule)

  // Champs propres a ce telephone (jamais partages).
  function defaultUi() {
    return {
      screen: 'onboard',
      ob: 0,
      name: '',
      err: '',
      cur: null,
      flipped: false,
      revealAt: null,
      tab: 'village',
      rview: 'partie',
      space: null
    };
  }
  var UI_PERSISTED = ['screen', 'ob', 'tab', 'rview', 'space', 'cur', 'name'];

  function loadUi() {
    var ui = defaultUi();
    try {
      var raw = localStorage.getItem(UI_KEY) || localStorage.getItem(LEGACY_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        UI_PERSISTED.forEach(function (k) { if (parsed[k] !== undefined) ui[k] = parsed[k]; });
      }
    } catch (e) { /* ignore */ }
    // Par confidentialite / coherence au rechargement de page.
    if (ui.screen === 'reveal') ui.screen = 'pioche';
    if (ui.screen === 'deck') ui.screen = 'setup';
    if (ui.screen === 'space') { ui.screen = 'hub'; ui.space = null; }
    return ui;
  }

  var state = Object.assign(Game.defaultShared(), loadUi());
  delete state.deck; // le paquet reste chez l'hote

  function save() {
    try {
      var o = {};
      UI_PERSISTED.forEach(function (k) { o[k] = state[k]; });
      localStorage.setItem(UI_KEY, JSON.stringify(o));
    } catch (e) { /* ignore */ }
  }

  // Heure commune a tous les telephones (celle de l'hote).
  function nowMs() { return transport.now(); }

  // --- Helpers de rendu ---
  // Blasons SVG pre-rendus cote serveur depuis views/partials/role_badge.ejs.
  // `fill` : couleur de surface sous le blason (par defaut celle des cartes).
  function badge(roleId, size, fill) {
    var svg = BADGES[roleId];
    if (!svg) return '';
    var h = Math.round(size * 58 / 48);
    return svg.replace('<svg ', '<svg style="width:' + size + 'px;height:' + h + 'px;flex:none;display:block' +
      (fill ? ';--vf-badge-fill:' + fill : '') + '" ');
  }

  function icon(name, size, filled) {
    return '<span class="' + (filled ? 'msr-fill' : 'msr') + '" style="font-size:' + size + 'px">' + name + '</span>';
  }

  // --- Coquille : ecran + rideau (le rideau survit aux re-rendus) ---
  var root = document.getElementById('app');
  root.innerHTML = '<div class="vf-viewport"><div class="vf-frame">' +
    '<div id="vf-screen" class="vf-screen"></div><div id="vf-sheet"></div><div id="vf-link"></div><div id="vf-curtain"></div></div></div>';
  var screenEl = document.getElementById('vf-screen');
  var curtainEl = document.getElementById('vf-curtain');
  var linkEl = document.getElementById('vf-link');

  var ANIM = {
    f: 'vfPush .34s cubic-bezier(.2,.8,.2,1) both',
    b: 'vfBack .34s cubic-bezier(.2,.8,.2,1) both',
    fade: 'vfFade .3s ease-out both'
  };
  var enter = 'fade';
  function enterAnim() { return enter === 'none' ? '' : 'animation:' + ANIM[enter] + ';'; }

  function render() {
    screenEl.innerHTML = renderScreen();
    enter = 'none';
  }

  // Re-rendu apres un changement venu de la partie : garde le focus et la saisie du prenom.
  function refresh() {
    var active = document.activeElement;
    var typing = active && active.id === 'vf-name';
    var sel = null;
    if (typing) { state.name = active.value; sel = [active.selectionStart, active.selectionEnd]; }
    render();
    if (typing) {
      var again = document.getElementById('vf-name');
      if (again) {
        again.focus();
        try { again.setSelectionRange(sel[0], sel[1]); } catch (e) { /* ignore */ }
      }
    }
  }

  function dispatch(action, cb) { transport.dispatch(action, cb); }

  // Change d'ecran avec une direction d'animation ('f', 'b' ou 'fade').
  function go(screen, dir, patch) {
    state.screen = screen;
    if (patch) Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
    enter = dir || 'fade';
    save();
    render();
  }

  // La phase de la partie (setup, pioche, hub, recap) est commune ; l'ecran exact est propre a
  // chaque telephone dans les limites de la phase (ex. onboard/setup/deck pendant la mise en place).
  var PHASE_ORDER = { setup: 0, pioche: 1, hub: 2, recap: 3 };
  var PHASE_SCREENS = { setup: ['onboard', 'setup', 'deck'], pioche: ['pioche', 'reveal'], hub: ['hub', 'space'], recap: ['recap'] };
  var PHASE_PATCH = {
    setup: {},
    pioche: { cur: null, flipped: false, revealAt: null, name: '', err: '', space: null },
    hub: { tab: 'village', space: null },
    recap: { space: null }
  };
  var SKIP_REFRESH = ['deck', 'reveal']; // ecrans qui ne dependent pas des autres joueurs

  // Ramene ce telephone sur un ecran compatible avec la phase. Renvoie true s'il a change d'ecran.
  function syncScreen(prevPhase) {
    var allowed = PHASE_SCREENS[state.phase] || PHASE_SCREENS.setup;
    if (allowed.indexOf(state.screen) !== -1) return false;
    // Un joueur qui regarde sa carte n'en est pas arrache quand la partie demarre.
    if (state.screen === 'reveal' && state.phase === 'hub' && state.players[state.cur]) return false;
    var target = state.phase === 'setup' ? 'setup' : allowed[0];
    var dir = !prevPhase ? 'fade' : PHASE_ORDER[state.phase] >= PHASE_ORDER[prevPhase] ? 'f' : 'b';
    go(target, dir, PHASE_PATCH[state.phase]);
    return true;
  }

  function sharedKey() {
    var o = {};
    Game.SHARED_KEYS.forEach(function (k) { if (k !== 'rev' && k !== 'deck') o[k] = state[k]; });
    return JSON.stringify(o);
  }

  // Un nouvel etat de la partie arrive (de ce telephone ou d'un autre).
  function onShared(v) {
    var first = !ready;
    var prevPhase = first ? null : state.phase;
    var prevKey = first ? null : sharedKey();
    Object.keys(v).forEach(function (k) { state[k] = v[k]; });
    ready = true;
    showLink();
    if (sheet && prevPhase && prevPhase !== state.phase) closeSheet();
    var announce = !first && state.ann && state.ann.id !== seenAnn;
    if (state.ann) seenAnn = state.ann.id; // a la connexion, on ne rejoue pas une ancienne annonce
    var askMax = (state.ask || []).reduce(function (m, q) { return Math.max(m, q.id); }, 0);
    var newAsk = !first && askMax > seenAsk;
    seenAsk = Math.max(seenAsk, askMax);
    if (sheet && sheet.kind === 'devoured' && !askById(sheet.id)) closeSheet(); // quelqu'un d'autre a deja repondu
    var moved = syncScreen(prevPhase);
    if (!moved && (first || prevKey !== sharedKey()) && SKIP_REFRESH.indexOf(state.screen) === -1) refresh();
    if (announce && state.phase === 'hub' && state.screen !== 'reveal' && soldierIds().length) openSheet({ kind: 'soldiers' });
    if (newAsk && state.phase === 'hub' && state.screen !== 'reveal' && state.ask.length) openSheet({ kind: 'devoured', id: state.ask[0].id });
  }

  function onStatus(s) {
    link = s;
    showLink();
    if (!ready) render();
  }

  function showLink() {
    linkEl.innerHTML = ready && link !== 'online' ? '<div class="vf-link">Connexion perdue · reconnexion…</div>' : '';
  }

  function curtain(text, iconName, applyPatch) {
    curtainEl.innerHTML =
      '<div class="vf-curtain">' +
        '<div class="vf-diamond">' + icon(iconName, 34) + '</div>' +
        '<span class="vf-curtain-text">' + text + '</span>' +
      '</div>';
    setTimeout(applyPatch, 240);
    setTimeout(function () { curtainEl.innerHTML = ''; }, 1100);
  }

  function renderConnecting() {
    return '<div class="vf-todo">' +
      '<div class="vf-diamond" style="animation:vfSpin .8s ease-in-out infinite alternate">' + icon('sync_alt', 34) + '</div>' +
      '<p class="vf-body">' + (link === 'offline' ? 'Connexion impossible… nouvelle tentative.' : 'Connexion à la partie…') + '</p>' +
      '</div>';
  }

  function renderScreen() {
    if (!ready) return renderConnecting();
    switch (state.screen) {
      case 'onboard': return renderOnboard();
      case 'setup': return renderSetup();
      case 'pioche': return renderPioche();
      case 'reveal': return renderReveal();
      case 'deck': return renderDeck();
      case 'hub': return renderHub();
      case 'space': return renderSpace();
      case 'recap': return renderRecap();
      default: return renderTodo();
    }
  }

  function renderTodo() {
    return '<div class="vf-todo">' +
      '<p class="vf-body">Cet ecran arrive dans une prochaine etape.</p>' +
      '<button class="vf-btn-gold" data-action="back-onboard">Retour a l\'accueil</button>' +
      '</div>';
  }

  // ---- Ecran 1 : Accueil (3 pages) ----
  var OB_NUMERALS = ['I', 'II', 'III'];
  var OB_CTAS = ['Suivant', 'Suivant', 'Préparer la partie'];

  function renderOnboard() {
    var body;
    if (state.ob === 0) body = renderOnboardPage0();
    else if (state.ob === 1) body = renderOnboardPage1();
    else body = renderOnboardPage2();

    var dots = [0, 1, 2].map(function (i) {
      return '<span class="vf-dot' + (i === state.ob ? ' is-active' : '') + '"></span>';
    }).join('');

    return '<div class="vf-onboard" style="' + enterAnim() + '">' +
      '<div class="vf-onboard-skip-row"><button class="vf-skip" data-action="ob-skip">Passer</button></div>' +
      '<div class="vf-onboard-scroll">' +
        '<span class="vf-numeral">' + OB_NUMERALS[state.ob] + '</span>' +
        body +
      '</div>' +
      '<div class="vf-dots">' + dots + '</div>' +
      '<button class="vf-btn-gold" data-action="ob-next">' + OB_CTAS[state.ob] + '</button>' +
      '</div>';
  }

  function renderOnboardPage0() {
    var fanCards = [
      { id: 'loup_garou', style: 'transform:rotate(-12deg) translateY(10px)' },
      { id: 'roi', style: 'transform:translateY(-6px)' },
      { id: 'espion', style: 'transform:rotate(12deg) translateY(10px)' }
    ];
    var fanHtml = fanCards.map(function (f) {
      return '<div class="vf-fan-card" style="' + f.style + '">' + badge(f.id, 56) + '</div>';
    }).join('');
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:20px;animation:vfTab .3s ease-out both">' +
      '<div class="vf-fan">' + fanHtml + '</div>' +
      '<h1 class="vf-h1-lg">Village<br><span style="color:var(--vf-gold)">&amp;</span> Fantaisy</h1>' +
      '<p class="vf-body">Jeu de rôles cachés joué en parallèle de la soirée.</p>' +
      '</div>';
  }

  function renderOnboardPage1() {
    var camps = [
      { id: 'roi', color: 'var(--vf-royaume)', label: 'Royaume', short: 'Démasquer les Vilains' },
      { id: 'diable', color: 'var(--vf-vilains)', label: 'Vilains', short: 'Éliminer le village' },
      { id: 'voleur', color: 'var(--vf-autres)', label: 'Autres', short: 'Gagner seuls' }
    ];
    var campsHtml = camps.map(function (c) {
      return '<div class="vf-camp-tile" style="border-top-color:' + c.color + '">' +
        badge(c.id, 44) +
        '<span class="vf-camp-label" style="color:' + c.color + '">' + c.label + '</span>' +
        '<span class="vf-camp-short">' + c.short + '</span>' +
        '</div>';
    }).join('');
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:20px;align-self:stretch;animation:vfTab .3s ease-out both">' +
      '<h1 class="vf-h1">Trois camps</h1>' +
      '<div class="vf-camps-grid">' + campsHtml + '</div>' +
      '</div>';
  }

  function renderOnboardPage2() {
    var steps = MULTI ? [
      'Chacun joue sur son téléphone : isole-toi pour tirer ta carte, personne ne doit la voir.',
      'Tous les téléphones affichent le même Village, mis à jour en direct.',
      'Besoin de ton pouvoir ? Ouvre ton espace secret, puis referme-le pour que personne ne le voie.'
    ] : [
      'Chacun son tour, isole-toi pour tirer ta carte, puis passe le téléphone.',
      'Pendant la partie, le téléphone reste au centre, sur le Village.',
      'Besoin de ton pouvoir ? Ouvre ton espace secret, puis referme-le avant de le rendre.'
    ];
    var stepsHtml = steps.map(function (text, i) {
      return '<div class="vf-step-row"><span class="vf-step-roman">' + OB_NUMERALS[i] + '</span><span class="vf-step-text">' + text + '</span></div>';
    }).join('');
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;align-self:stretch;animation:vfTab .3s ease-out both">' +
      '<h1 class="vf-h1">' + (MULTI ? 'Chacun son téléphone' : 'Un seul téléphone') + '</h1>' +
      '<div class="vf-steps">' + stepsHtml + '</div>' +
      '</div>';
  }

  // ---- Ecran 2 : Mise en place ----
  var sumCounts = Game.sumCounts;
  function currentCounts() { return state.custom; }

  function defaultPool() { return Game.defaultPool(); }
  function isDefaultPool() {
    var d = defaultPool(), c = state.custom;
    var keys = Object.keys(d).concat(Object.keys(c));
    return keys.every(function (k) { return (d[k] || 0) === (c[k] || 0); });
  }

  function renderSetup() {
    var counts = currentCounts();
    var order = Object.keys(ROLES).filter(function (id) { return counts[id] > 0; });

    var groups = CAMPS.map(function (camp) {
      var ids = order.filter(function (id) { return ROLES[id].camp === camp; });
      if (!ids.length) return '';
      var total = ids.reduce(function (n, id) { return n + counts[id]; }, 0);
      var tiles = ids.map(function (id) {
        var pill = counts[id] > 1 ? '<span class="vf-count-pill">×' + counts[id] + '</span>' : '';
        return '<div class="vf-role-tile">' + pill + badge(id, 36) +
          '<span class="vf-role-tile-name">' + ROLES[id].name + '</span></div>';
      }).join('');
      return '<div style="display:flex;flex-direction:column;gap:8px">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<span class="vf-group-title" style="color:' + CAMP_COLOR[camp] + '">' + CAMP_LABEL[camp] + ' · ' + total + '</span>' +
          '<span style="flex:1;height:1px;background:var(--vf-border)"></span>' +
        '</div>' +
        '<div class="vf-tiles-4">' + tiles + '</div>' +
      '</div>';
    }).join('');

    var customBlock = '<div style="display:flex;flex-direction:column;align-items:center;gap:8px">' +
      '<span class="vf-pill">' + icon('tune', 18) + sumCounts(state.custom) + ' personnages possibles</span>' +
      '<button class="vf-btn-outline" data-action="open-deck">Modifier la liste</button>' +
      (isDefaultPool() ? '' : '<button class="vf-btn-text" data-action="custom-reset">Rétablir la liste par défaut</button>') + '</div>';

    return '<div class="vf-page" style="' + enterAnim() + '">' +
      '<button class="vf-icon-btn" data-action="setup-back" aria-label="Retour">' + icon('arrow_back', 24) + '</button>' +
      '<div class="vf-scroll" style="justify-content:flex-start;gap:22px;padding:4px 12px 16px">' +
        '<h1 class="vf-h1">Combien<br>de joueurs ?</h1>' +
        '<div style="display:flex;align-items:center;gap:20px">' +
          '<button class="vf-round-btn" data-action="count-dec" aria-label="Moins">' + icon('remove', 28) + '</button>' +
          '<span class="vf-count">' + state.count + '</span>' +
          '<button class="vf-round-btn" data-action="count-inc" aria-label="Plus">' + icon('add', 28) + '</button>' +
        '</div>' +
        '<p class="vf-body-sm">Les cartes sont tirées au hasard parmi les personnages possibles : personne ne connaît la composition exacte.</p>' +
        customBlock +
        '<div style="display:flex;flex-direction:column;gap:14px;align-self:stretch">' + groups + '</div>' +
      '</div>' +
      '<div style="flex:none;display:flex;flex-direction:column;padding:12px 12px 0">' +
        '<button class="vf-btn-gold" data-action="start-pioche">Mélanger et piocher</button>' +
      '</div>' +
      '</div>';
  }

  // ---- Ecran 3 : Pioche (repete pour chaque joueur) ----
  function renderPioche() {
    var total = state.count;
    var drawn = state.players.length;
    var remaining = total - drawn;

    var back = drawn === 0
      ? '<button class="vf-icon-btn" data-action="pioche-back" aria-label="Retour">' + icon('arrow_back', 24) + '</button>'
      : '<span style="height:48px"></span>';

    var content;
    if (remaining > 0) {
      var errText = state.err === 'dup' ? 'Ce prénom est déjà pris.'
        : state.err === 'offline' ? 'Connexion perdue : réessaie dans un instant.'
        : state.err === 'full' ? 'Toutes les cartes sont déjà tirées.'
        : 'Entre ton prénom pour piocher.';
      content =
        '<div class="vf-scroll" style="padding:0 16px 12px;text-align:center">' +
          '<div class="vf-pill">' + icon('style', 18) + 'Carte ' + (drawn + 1) + ' sur ' + total + '</div>' +
          '<h1 class="vf-h1">Quel est<br>ton prénom ?</h1>' +
          '<p class="vf-body-sm" style="max-width:280px;font-size:15px">Isole-toi : personne ne doit voir la carte que tu vas tirer.</p>' +
          '<input id="vf-name" class="vf-input" type="text" value="' + escapeAttr(state.name) + '" placeholder="Ton prénom" autocomplete="off" autocapitalize="words" maxlength="24">' +
          (state.err ? '<p class="vf-error">⚠  ' + errText + '</p>' : '') +
        '</div>' +
        '<div style="flex:none;display:flex;flex-direction:column;gap:12px;padding:0 12px;align-items:center">' +
          '<button class="vf-btn-gold" style="align-self:stretch" data-action="draw">Tirer ma carte</button>' +
          '<span style="color:var(--vf-muted);font-size:13px">' + remaining + (remaining > 1 ? ' cartes restantes' : ' carte restante') + ' dans le paquet</span>' +
        '</div>';
    } else {
      content =
        '<div class="vf-scroll" style="padding:0 24px;text-align:center">' +
          '<div class="vf-diamond" style="animation:vfSpin .5s cubic-bezier(.2,.8,.2,1) both">' + icon('done_all', 34) + '</div>' +
          '<h1 class="vf-h1" style="font-size:22px">Toutes les cartes<br>sont tirées</h1>' +
          '<p class="vf-body-sm" style="font-size:15px">' + (MULTI ? 'Touche le bouton : le Village s\'affiche sur tous les téléphones.' : 'Pose le téléphone au centre : la partie commence.') + '</p>' +
          '<button class="vf-btn-gold" style="align-self:stretch" data-action="to-hub">Commencer la partie</button>' +
        '</div>';
    }

    return '<div class="vf-page" style="' + enterAnim() + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' + back + '<span style="height:48px"></span></div>' +
      content +
      '</div>';
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // ---- Ecran 4 : Revelation (retournement de carte) ----
  // Numero de boite : saisi a la main (par role) sinon rang du joueur parmi ceux dont le role a des objets.
  function boxNumberOf(player) {
    var manual = state.boxes && state.boxes[player.role];
    if (manual) return escapeAttr(manual);
    return String(autoBox(player.role));
  }
  // Numero automatique : rang du personnage parmi tous ceux qui ont une boite (Sorciere 1, Loup-garou 2...),
  // toujours le meme d'une partie a l'autre pour pouvoir preparer les boites a l'avance.
  function autoBox(roleId) {
    return Object.keys(ROLES).filter(function (id) { return ROLES[id].needsBox; }).indexOf(roleId) + 1;
  }
  function boxItemsText(role) { return role.boxItems ? ' (' + role.boxItems + ')' : ''; }

  function secondsLeft() {
    if (!state.revealAt) return REVEAL_SECONDS;
    return Math.max(0, REVEAL_SECONDS - Math.floor((Date.now() - state.revealAt) / 1000));
  }

  function renderReveal() {
    var player = state.players[state.cur];
    if (!player) return renderPioche();
    var role = ROLES[player.role];

    var objLine = '';
    if (role.item) {
      objLine = '<div class="vf-obj">' + icon('workspace_premium', 22) + 'Prends : ' + role.item + '</div>';
    } else if (role.needsBox) {
      objLine = '<div class="vf-obj">' + icon('inventory_2', 22) + 'Tes objets : boîte n° ' + boxNumberOf(player) + boxItemsText(role) + '</div>';
    }

    var flipped = state.flipped;
    return '<div class="vf-scroll vf-reveal" style="justify-content:flex-start;padding:24px;gap:18px;' + enterAnim() + '">' +
      '<p style="margin:0;color:var(--vf-gold);font-size:12px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase">' + escapeAttr(player.name) + '</p>' +
      '<div class="vf-card-wrap" data-action="flip">' +
        '<div id="vf-card-inner" class="vf-card-inner" style="transform:' + (flipped ? 'rotateY(180deg)' : 'rotateY(0deg)') + '">' +
          '<div class="vf-card-face vf-card-back">' +
            '<div class="vf-card-frame"></div>' +
            '<div class="vf-diamond" style="width:96px;height:96px"><span style="font-size:22px;font-weight:800;letter-spacing:0.08em;color:var(--vf-gold)">V&amp;F</span></div>' +
          '</div>' +
          '<div class="vf-card-face vf-card-front">' +
            '<div class="vf-card-frame"></div>' +
            '<span style="font-size:12px;font-weight:700;letter-spacing:0.24em;color:var(--vf-gold);text-transform:uppercase">' + CAMP_LABEL[role.camp] + (role.known ? ' · ***' : '') + '</span>' +
            badge(role.id, 104) +
            '<div style="display:flex;flex-direction:column;align-items:center;gap:6px">' +
              '<h1 style="margin:0;font-size:28px;line-height:1.1;text-align:center;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">' + role.name + '</h1>' +
              '<span style="width:40px;height:1px;background:var(--vf-gold)"></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<p id="vf-hint" class="vf-hint" ' + (flipped ? 'hidden' : '') + '>Touche la carte pour la retourner.</p>' +
      '<div id="vf-details" class="vf-details" ' + (flipped ? '' : 'hidden') + '>' +
        '<p style="margin:0;font-size:16px;line-height:1.55;text-wrap:pretty">' + role.description + '</p>' +
        objLine +
        '<button class="vf-btn-gold" style="align-self:stretch" data-action="next-player">J\'ai mémorisé' + (MULTI ? '' : ' · joueur suivant') + '</button>' +
        '<span id="vf-autohide" style="color:var(--vf-muted);font-size:12px;font-variant-numeric:tabular-nums">La carte se cache seule dans ' + secondsLeft() + ' s</span>' +
      '</div>' +
      '</div>';
  }

  function flipCard() {
    state.flipped = !state.flipped;
    if (!state.revealAt) state.revealAt = Date.now();
    save();
    var inner = document.getElementById('vf-card-inner');
    var hint = document.getElementById('vf-hint');
    var details = document.getElementById('vf-details');
    if (!inner) return;
    inner.style.transform = state.flipped ? 'rotateY(180deg)' : 'rotateY(0deg)';
    hint.hidden = state.flipped;
    details.hidden = !state.flipped;
  }

  var leaving = false;
  function nextPlayer() {
    if (leaving) return;
    leaving = true;
    curtain(MULTI ? 'Carte mémorisée' : 'Passe le téléphone', 'sync_alt', function () {
      leaving = false;
      go('pioche', 'fade', { flipped: false, revealAt: null, cur: null });
      syncScreen(state.phase);
    });
  }

  // Compte a rebours d'auto-masquage de la carte revelee.
  setInterval(function () {
    if (state.screen === 'space') { updateTimer(); updateSucWait(); }
    if (state.screen !== 'reveal' || !state.flipped || !state.revealAt) return;
    if (Date.now() - state.revealAt > REVEAL_SECONDS * 1000) { nextPlayer(); return; }
    var el = document.getElementById('vf-autohide');
    if (el) el.textContent = 'La carte se cache seule dans ' + secondsLeft() + ' s';
  }, 1000);

  // ==== Hub, espace secret, fin de partie ====
  var RULES = [
    'Le jeu se joue en parallèle de la soirée : chacun garde son rôle secret.',
    MULTI ? 'Chacun joue sur son téléphone : tous affichent le même Village, mis à jour en direct.'
      : 'Un seul téléphone : il reste posé au centre, sur l\'écran Village.',
    'Toutes les 30 minutes, le Hérault réunit le village et organise le vote.',
    'Les rôles marqués *** sont connus de tous dès le départ, avec leur objet.',
    'Un joueur éliminé ne parle plus et ne vote plus.',
    'Pour utiliser un pouvoir, ouvre ton espace secret à l\'écart, puis referme-le.'
  ];
  var ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
  var WIN_TITLE = { royaume: 'Le Royaume l\'emporte', vilains: 'Les Vilains l\'emportent', autres: 'Un solitaire l\'emporte' };
  var HERALD_MS = 30 * 60000;

  var sheet = null; // feuille du bas (transitoire, non persistee)
  var sheetEl = document.getElementById('vf-sheet');

  function initial(name) { return escapeAttr(name.charAt(0).toUpperCase()); }
  function aliveIds() { return Game.aliveIds(state.players); }

  function dividerTitle(camp, total) {
    return '<div style="display:flex;align-items:center;gap:10px">' +
      '<span class="vf-group-title" style="color:' + CAMP_COLOR[camp] + '">' + CAMP_LABEL[camp] + ' · ' + total + '</span>' +
      '<span style="flex:1;height:1px;background:var(--vf-border)"></span></div>';
  }

  // Grille de roles par camp (onglet Roles). `counts` : null pour "tous les roles".
  function roleGroupsHtml(ids, counts) {
    return CAMPS.map(function (camp) {
      var list = ids.filter(function (id) { return ROLES[id].camp === camp; });
      if (!list.length) return '';
      var total = list.reduce(function (n, id) { return n + (counts ? counts[id] : 1); }, 0);
      var tiles = list.map(function (id) {
        var n = counts ? counts[id] : 0;
        var pill = n > 1 ? '<span class="vf-count-pill" style="top:6px;right:6px;font-size:11px;padding:1px 6px">×' + n + '</span>' : '';
        return '<button class="vf-tile-btn" style="position:relative;border-radius:10px;padding:14px 6px 10px;gap:8px" data-action="role-detail" data-arg="' + id + '">' +
          pill + badge(id, 40) + '<span style="font-size:12.5px;font-weight:700;line-height:1.2">' + ROLES[id].name + '</span></button>';
      }).join('');
      return '<div style="display:flex;flex-direction:column;gap:10px">' + dividerTitle(camp, total) + '<div class="vf-grid3">' + tiles + '</div></div>';
    }).join('');
  }

  function renderHub() {
    var ps = state.players;
    var alive = aliveIds().length;
    var titles = {
      village: ['Village', alive + ' en vie · ' + (ps.length - alive) + ' éliminé(s)'],
      secret: ['Espaces secrets', 'Un joueur à la fois, à l\'écart'],
      roles: ['Rôles', ps.length + ' joueurs']
    };
    var t = titles[state.tab] || titles.village;
    var body = state.tab === 'secret' ? hubSecret() : state.tab === 'roles' ? hubRoles() : hubVillage();

    var navItems = [['village', 'groups', 'Village'], ['secret', 'lock', 'Espaces'], ['roles', 'menu_book', 'Rôles']];
    var nav = navItems.map(function (n) {
      var on = state.tab === n[0];
      var color = on ? 'var(--vf-gold)' : 'var(--vf-muted)';
      return '<button class="' + (on ? 'is-on' : '') + '" data-action="hub-tab" data-arg="' + n[0] + '">' +
        '<span style="color:' + color + ';transition:color .2s ease">' + icon(n[1], 26, on) + '</span>' +
        '<span class="vf-nav-label" style="color:' + color + '">' + n[2] + '</span>' +
        '<span class="vf-nav-dot"></span></button>';
    }).join('');

    return '<div class="vf-hub" style="' + enterAnim() + '">' +
      '<div class="vf-hub-head"><span class="vf-hub-title">' + t[0] + '</span><span class="vf-hub-sub">' + t[1] + '</span></div>' +
      '<div class="vf-hub-body">' + body + '</div>' +
      '<div class="vf-nav">' + nav + '</div></div>';
  }

  function avatarInner(p, size) {
    var rr = ROLES[p.role];
    return rr.known ? badge(p.role, size, 'var(--vf-bg)') : initial(p.name);
  }

  function hubVillage() {
    var ps = state.players;
    var alive = aliveIds().length;
    var N = ps.length || 1;
    var table;
    if (ps.length <= 12) {
      var seats = ps.map(function (p, i) {
        var rr = ROLES[p.role];
        var ang = (-90 + i * 360 / N) * Math.PI / 180;
        var left = (50 + 41.2 * Math.cos(ang)).toFixed(2) + '%';
        var top = (47.2 + 38.9 * Math.sin(ang)).toFixed(2) + '%';
        var ring = rr.known ? CAMP_COLOR[rr.camp] : 'var(--vf-border)';
        return '<button data-action="open-player" data-arg="' + i + '" style="appearance:none;background:none;border:none;padding:0;color:var(--vf-text);font-family:inherit;cursor:pointer;position:absolute;width:76px;display:flex;flex-direction:column;align-items:center;gap:4px;transform:translate(-50%,-24px);left:' + left + ';top:' + top + ';opacity:' + (p.dead ? 0.35 : 1) + ';transition:opacity .3s ease">' +
          '<span class="vf-avatar" style="border-color:' + ring + '">' + avatarInner(p, 22) + '</span>' +
          '<span style="font-size:12px;font-weight:600;white-space:nowrap;text-decoration:' + (p.dead ? 'line-through' : 'none') + '">' + escapeAttr(p.name) + '</span></button>';
      }).join('');
      table = '<div style="position:relative;width:100%;max-width:340px;aspect-ratio:340/360;align-self:center;flex:none">' +
        '<div style="position:absolute;left:18.2%;top:17.2%;width:63.6%;aspect-ratio:1;border-radius:999px;border:1px solid rgba(227,178,94,0.35);background:radial-gradient(circle, rgba(227,178,94,0.08), transparent 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px">' +
        '<span style="font-size:48px;font-weight:800;color:var(--vf-gold);line-height:1">' + alive + '</span>' +
        '<span style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:var(--vf-muted)">en vie sur ' + ps.length + '</span></div>' +
        seats + '</div>';
    } else {
      table = '<div class="vf-grid3">' + ps.map(function (p, i) {
        var rr = ROLES[p.role];
        var ring = rr.known ? CAMP_COLOR[rr.camp] : 'var(--vf-border)';
        return '<button class="vf-tile-btn" data-action="open-player" data-arg="' + i + '" style="padding:12px 6px 10px;gap:6px;opacity:' + (p.dead ? 0.35 : 1) + '">' +
          '<span class="vf-avatar" style="background:var(--vf-bg);border-color:' + ring + '">' + avatarInner(p, 22) + '</span>' +
          '<span style="font-size:13px;font-weight:700;text-decoration:' + (p.dead ? 'line-through' : 'none') + '">' + escapeAttr(p.name) + '</span></button>';
      }).join('') + '</div>';
    }
    var askBanner = (state.ask && state.ask.length && state.players[state.ask[0].pid])
      ? '<button class="vf-tile-btn" data-action="ask-open" style="flex-direction:row;gap:12px;padding:12px 14px;text-align:left;border-color:var(--vf-vilains)">' +
        '<span style="flex:none;color:var(--vf-vilains)">' + icon('pets', 26) + '</span>' +
        '<span style="flex:1;font-size:14px;font-weight:700;line-height:1.35">' + escapeAttr(state.players[state.ask[0].pid].name) + ' a été dévoré(e) · porte-t-elle la marque ?</span>' +
        '<span style="color:var(--vf-muted)">' + icon('chevron_right', 22) + '</span></button>' : '';
    return '<div class="vf-col">' + askBanner + table +
      '<div style="display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:center;font-size:12px;color:var(--vf-muted)">' +
        '<span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:999px;border:2px solid var(--vf-royaume)"></span>Rôle connu de tous ***</span>' +
        '<span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:999px;border:2px solid var(--vf-border);opacity:0.5"></span>Éliminé</span></div>' +
      '<p style="margin:-8px 0 0;color:var(--vf-muted);font-size:13px;text-align:center">Touche un joueur pour déclarer une élimination.</p>' +
      '<button class="vf-btn-outline" data-action="ask-end">Fin de partie · révéler les cartes</button></div>';
  }

  function hubSecret() {
    var tiles = state.players.map(function (p, i) {
      return '<button class="vf-tile-btn" data-action="ask-space" data-arg="' + i + '" style="padding:14px 6px 12px;gap:8px;opacity:' + (p.dead ? 0.5 : 1) + '">' +
        '<span class="vf-initial" style="width:44px;height:44px;font-size:16px">' + initial(p.name) + '</span>' +
        '<span style="font-size:13px;font-weight:700;text-decoration:' + (p.dead ? 'line-through' : 'none') + '">' + escapeAttr(p.name) + '</span></button>';
    }).join('');
    return '<div class="vf-col" style="gap:18px">' +
      '<div class="vf-dash"><span style="color:var(--vf-gold)">' + icon('visibility_off', 26) + '</span>' +
      '<span style="font-size:14px;line-height:1.5;text-wrap:pretty">Besoin de revoir ton rôle ou d\'utiliser ton pouvoir ? Touche ton prénom, isole-toi, puis referme ton espace' + (MULTI ? '.' : ' avant de rendre le téléphone.') + '</span></div>' +
      '<div class="vf-grid3">' + tiles + '</div></div>';
  }

  function hubRoles() {
    var tabs = [['partie', 'Rôles possibles'], ['tous', 'Tous les rôles'], ['regles', 'Règles']].map(function (t) {
      var on = state.rview === t[0];
      return '<button data-action="roles-view" data-arg="' + t[0] + '" style="appearance:none;border:none;background:none;flex:1;height:44px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;transition:color .2s ease, border-color .2s ease;color:' + (on ? 'var(--vf-gold)' : 'var(--vf-muted)') + ';border-bottom:2px solid ' + (on ? 'var(--vf-gold)' : 'transparent') + ';margin-bottom:-1px">' + t[1] + '</button>';
    }).join('');

    var content;
    if (state.rview === 'regles') {
      content = '<div style="display:flex;flex-direction:column;animation:vfFade .25s ease-out both">' +
        RULES.map(function (text, i) {
          return '<div class="vf-rule"><span style="flex:none;width:30px;font-size:13px;font-weight:800;letter-spacing:0.1em;color:var(--vf-gold)">' + ROMAN[i] + '</span>' +
            '<span style="font-size:15px;line-height:1.5;text-wrap:pretty">' + text + '</span></div>';
        }).join('') + '</div>' +
        '<button class="vf-btn-outline is-danger" data-action="ask-reset">↻  Tout recommencer</button>';
    } else {
      // Liste personnalisee : on montre les roles possibles (sans quantites, pour ne pas reveler le paquet reel).
      var pool = state.custom;
      var counts = {};
      state.players.forEach(function (p) { counts[p.role] = (counts[p.role] || 0) + 1; });
      var all = state.rview === 'tous';
      var ids = Object.keys(ROLES).filter(function (id) { return all || (pool ? pool[id] : counts[id]); });
      content = '<div style="display:flex;flex-direction:column;gap:20px;animation:vfFade .25s ease-out both">' +
        '<p style="margin:0;color:var(--vf-muted);font-size:13px;text-align:center">' +
        (all ? 'Tous les rôles du jeu. Touche un rôle pour le détail.' : 'Rôles qui peuvent apparaître dans cette partie. Touche un rôle pour le détail.') + '</p>' +
        roleGroupsHtml(ids, all || pool ? null : counts) + '</div>';
    }
    return '<div class="vf-col"><div style="display:flex;border-bottom:1px solid var(--vf-border);flex:none;margin:-4px 0 0">' + tabs + '</div>' + content + '</div>';
  }

  // ---- Feuille du bas ----
  function diamond64(iconName) {
    return '<div class="vf-diamond" style="width:64px;height:64px">' + icon(iconName, 28) + '</div>';
  }

  function optionsList(title, sub, options) {
    var opts = options.map(function (o) {
      return '<button class="vf-opt' + (o.sel ? ' is-sel' : '') + (o.dead ? ' is-dead' : '') + '"' +
        (o.disabled ? ' disabled' : ' data-action="' + o.action + '" data-arg="' + o.arg + '"') + '>' + o.visual +
        '<span style="font-size:13px;font-weight:700;line-height:1.2">' + o.label + '</span></button>';
    }).join('');
    return '<div style="padding:8px 24px 12px;display:flex;flex-direction:column;gap:6px;text-align:center">' +
      '<h3 style="margin:0;font-size:15px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:var(--vf-gold)">' + title + '</h3>' +
      '<p style="margin:0;color:var(--vf-muted);font-size:13px;line-height:1.45">' + sub + '</p></div>' +
      '<div class="vf-sheet-list">' + opts + '</div>';
  }
  // Joueur dans une liste de pouvoir : les eliminés sont signales ; `disabled` = visible mais non ciblable.
  var DEAD_TAG = '<br><span style="font-size:11px;color:var(--vf-muted);font-weight:600">Éliminé(e)</span>';
  function personOption(i, action, sel, disabled) {
    var p = state.players[i];
    return { action: action, arg: i, sel: sel, dead: !!p.dead, disabled: !!(disabled && p.dead),
      label: escapeAttr(p.name) + (p.dead ? DEAD_TAG : ''), visual: '<span class="vf-initial">' + initial(p.name) + '</span>' };
  }
  // Vivants d'abord, puis les eliminés.
  function othersAliveFirst(owner, keep) {
    var ids = state.players.map(function (p, i) { return i; }).filter(function (i) { return i !== owner && (!keep || keep(i)); });
    return ids.filter(function (i) { return !state.players[i].dead; }).concat(ids.filter(function (i) { return state.players[i].dead; }));
  }

  function sheetInner() {
    var ps = state.players;
    var owner = state.space;
    switch (sheet.kind) {
      case 'priest':
        return optionsList('Consulter un rôle', 'Choisis un joueur, vivant ou éliminé : son rôle te sera révélé, à toi seul.',
          othersAliveFirst(owner, function (i) { return state.pr.indexOf(i) === -1; })
            .map(function (i) { return personOption(i, 'priest-pick', false); }));
      case 'fee':
        return optionsList('Protéger un joueur', 'Le jeton le protège d\'une mort ou d\'une transformation jusqu\'au prochain vote.',
          othersAliveFirst(owner).map(function (i) { return personOption(i, 'fee-pick', state.fee === i, true); }));
      case 'spy':
        return optionsList('Rôle de ' + escapeAttr(ps[sheet.pid].name), 'Ta supposition reste secrète jusqu\'à la fin.',
          Object.keys(ROLES).map(function (id) {
            return { action: 'spy-pick', arg: id, sel: state.spy[sheet.pid] === id, label: ROLES[id].name, visual: badge(id, 32, 'var(--vf-bg)') };
          }));
      case 'pardon':
        return '<div class="vf-sheet-body">' + diamond64('balance') +
          '<h2 class="vf-sheet-title">' + escapeAttr(ps[sheet.pid].name) + ' est gracié(e)</h2>' +
          '<p class="vf-sheet-text">La manche est terminée : le minuteur du Hérault repart à 30 min et les pouvoirs de manche (protection de la Fée, morsure du Vampire) sont relancés.</p>' +
          '<button class="vf-btn-sm" data-action="close-sheet">Fermer</button></div>';
      case 'devil':
        return '<div class="vf-sheet-body">' + diamond64('skull') +
          '<h2 class="vf-sheet-title">Le dernier Démon est mort</h2>' +
          '<p class="vf-sheet-text">' + (sheet.saved
            ? 'Le Diable (' + escapeAttr(ps[sheet.pid].name) + ') est protégé par la Fée : il survit. La protection est consommée.'
            : 'Le Diable (' + escapeAttr(ps[sheet.pid].name) + ') meurt avec les Démons.') + '</p>' +
          '<button class="vf-btn-sm" data-action="close-sheet">Fermer</button></div>';
      case 'vamp':
        return optionsList('Convertir un joueur', 'Choisis un joueur vivant : il deviendra Rejeton vampire (sauf la Licorne).',
          othersAliveFirst(owner, function (i) {
            var r = ps[i].role;
            return r !== 'licorne' && r !== 'rejeton_vampire';
          }).map(function (i) { return personOption(i, 'vamp-pick', false, true); }));
      case 'soldiers':
        var names = soldierIds().map(function (i) { return escapeAttr(ps[i].name); }).join(', ');
        return '<div class="vf-sheet-body">' + diamond64('shield') +
          '<h2 class="vf-sheet-title">Le Roi est mort</h2>' +
          '<p class="vf-sheet-text">Les Soldats sont révélés et bannis du jeu : <strong style="color:var(--vf-gold)">' + names + '</strong>.</p>' +
          '<button class="vf-btn-sm" data-action="ban-soldiers">Bannir les Soldats</button>' +
          '<button class="vf-btn-text" data-action="close-sheet">Plus tard</button></div>';
      case 'cause':
        var isDevil = ps[sheet.pid].role === 'diable';
        return optionsList('Comment est-il mort ?', isDevil
            ? 'Le Diable ne peut pas être éliminé par le vote.'
            : 'Déclare la cause de l\'élimination de ' + escapeAttr(ps[sheet.pid].name) + '.',
          CAUSES.filter(function (c) { return !(isDevil && c.id === 'pendu'); }).map(function (c) {
            return { action: 'cause-pick', arg: c.id, sel: false, label: c.label + '<br><span style="font-size:11px;color:var(--vf-muted);font-weight:600">' + c.by + '</span>',
              visual: '<span style="color:var(--vf-gold)">' + icon(c.icon, 28) + '</span>' };
          }));
      case 'confirm':
        var who = escapeAttr(ps[sheet.pid].name);
        return '<div class="vf-sheet-body">' + diamond64('lock_open') +
          '<h2 class="vf-sheet-title">Espace de ' + who + '</h2>' +
          '<p class="vf-sheet-text">Vérifie que personne ne regarde l\'écran avant d\'ouvrir.</p>' +
          '<button class="vf-btn-sm" data-action="open-space" data-arg="' + sheet.pid + '">Je suis ' + who + ' · ouvrir</button>' +
          '<button class="vf-btn-text" data-action="close-sheet">Annuler</button></div>';
      case 'player':
        var p = ps[sheet.pid], rr = ROLES[p.role];
        var ring = rr.known ? CAMP_COLOR[rr.camp] : 'var(--vf-border)';
        var av = rr.known ? badge(p.role, 30, 'var(--vf-bg)') : initial(p.name);
        return '<div class="vf-sheet-body" style="gap:12px">' +
          '<span class="vf-avatar" style="width:64px;height:64px;border-color:' + ring + ';color:var(--vf-gold);font-weight:800;font-size:22px">' + av + '</span>' +
          '<h2 class="vf-sheet-title" style="margin:4px 0 0">' + escapeAttr(p.name) + '</h2>' +
          '<span style="color:var(--vf-muted);font-size:14px">' + (p.dead ? 'Éliminé(e)' + (p.cause ? ' · ' + causeLabel(p.cause) : '') : 'En vie') + (rr.known ? ' · ' + rr.name + ' ***' : '') + '</span>' +
          (sheet.saved ? '<div style="align-self:stretch;border:1px solid var(--vf-gold);background:rgba(227,178,94,0.12);color:var(--vf-gold);border-radius:12px;padding:12px 14px;font-size:14px;font-weight:700;animation:vfIn .25s ease-out">✦  Protégé par la Fée : a survécu ! La protection est consommée.</div>' : '') +
          '<button class="vf-btn-sm" style="background:' + (p.dead ? 'var(--vf-autres)' : 'var(--vf-vilains)') + '" data-action="toggle-player">' + (p.dead ? 'Ramener en jeu' : 'Déclarer éliminé(e)') + '</button>' +
          (p.dead ? '' : '<button class="vf-btn-outline" style="align-self:stretch" data-action="pardon-player">Déclarer gracié(e)</button>') +
          '<button class="vf-btn-text" data-action="close-sheet">Fermer</button></div>';
      case 'devoured':
        var dq = askById(sheet.id);
        if (!dq || !ps[dq.pid]) return '';
        var dname = escapeAttr(ps[dq.pid].name);
        return '<div class="vf-sheet-body">' + diamond64('pets') +
          '<h2 class="vf-sheet-title">' + dname + ' a été dévoré(e)</h2>' +
          '<p class="vf-sheet-text">Porte-t-elle la marque du Loup-garou (une gommette rouge) ? Si oui, elle est éliminée. Sinon, elle reste en vie.</p>' +
          '<button class="vf-btn-sm" style="background:var(--vf-vilains)" data-action="lg-verdict" data-arg="' + dq.id + ':1">Oui · éliminé(e)</button>' +
          '<button class="vf-btn-sm" style="background:var(--vf-autres)" data-action="lg-verdict" data-arg="' + dq.id + ':0">Non · reste en vie</button>' +
          '<button class="vf-btn-text" data-action="close-sheet">Plus tard</button></div>';
      case 'lg':
        return optionsList('Dévorer un joueur', 'Le joueur choisi ne meurt que s\'il porte une gommette rouge posée par toi. Tu ne pourras plus dévorer avant 40 minutes.',
          othersAliveFirst(owner).map(function (i) { return personOption(i, 'lg-pick', false, true); }));
      case 'lg-confirm':
        var lname = escapeAttr(ps[sheet.pid].name);
        return '<div class="vf-sheet-body">' + diamond64('pets') +
          '<h2 class="vf-sheet-title">Dévorer ' + lname + ' ?</h2>' +
          '<p class="vf-sheet-text">Pose d\'abord une gommette rouge sur ' + lname + '. Une minute plus tard, tous les joueurs verront « ' + lname + ' a été dévoré(e) » et vérifieront si elle porte ta marque : si oui elle est éliminée, sinon elle reste en vie. Tu ne pourras plus dévorer avant 40 minutes.</p>' +
          '<button class="vf-btn-sm" style="background:var(--vf-vilains)" data-action="lg-confirm" data-arg="' + sheet.pid + '">Dévorer</button>' +
          '<button class="vf-btn-text" data-action="close-sheet">Annuler</button></div>';
      case 'suc':
        return optionsList('Choisir une cible', 'Tu ne pourras plus en changer tant qu\'elle est en vie. Elle saura qu\'elle est ciblée.',
          othersAliveFirst(owner).map(function (i) { return personOption(i, 'suc-pick', false, true); }));
      case 'suc-confirm':
        var sname = escapeAttr(ps[sheet.pid].name);
        return '<div class="vf-sheet-body">' + diamond64('lock') +
          '<h2 class="vf-sheet-title">Cibler ' + sname + ' ?</h2>' +
          '<p class="vf-sheet-text">Tu ne pourras plus changer de cible tant que ' + sname + ' est en vie. ' + sname + ' sera prévenu(e) qu\'il ou elle est ciblé(e) par la Succube.</p>' +
          '<button class="vf-btn-sm" data-action="suc-confirm" data-arg="' + sheet.pid + '">Confirmer la cible</button>' +
          '<button class="vf-btn-text" data-action="close-sheet">Annuler</button></div>';
      case 'suc-kill':
        var kname = escapeAttr(ps[state.suc[owner].t].name);
        return '<div class="vf-sheet-body">' + diamond64('skull') +
          '<h2 class="vf-sheet-title">Mettre fin à la vie de ' + kname + ' ?</h2>' +
          '<p class="vf-sheet-text">Sa mort sera annoncée aux autres joueurs une minute plus tard. Tu ne pourras plus choisir d\'autre cible ensuite.</p>' +
          '<button class="vf-btn-sm" style="background:var(--vf-vilains)" data-action="suc-kill">Mettre fin à sa vie</button>' +
          '<button class="vf-btn-text" data-action="close-sheet">Annuler</button></div>';
      case 'info':
        return '<div class="vf-sheet-body">' + diamond64(sheet.icon) +
          '<h2 class="vf-sheet-title">' + sheet.title + '</h2>' +
          '<p class="vf-sheet-text">' + sheet.text + '</p>' +
          '<button class="vf-btn-sm" data-action="close-sheet">Fermer</button></div>';
      case 'end':
        return '<div class="vf-sheet-body">' + diamond64('flag') +
          '<h2 class="vf-sheet-title">Fin de partie ?</h2>' +
          '<p class="vf-sheet-text">Toutes les cartes seront révélées à tout le monde.</p>' +
          '<button class="vf-btn-sm" style="padding:18px 20px;font-size:15px;letter-spacing:0.12em" data-action="confirm-end">Révéler les cartes</button>' +
          '<button class="vf-btn-text" data-action="close-sheet">Annuler</button></div>';
      case 'reset':
        return '<div class="vf-sheet-body">' + diamond64('restart_alt') +
          '<h2 class="vf-sheet-title">Tout recommencer ?</h2>' +
          '<p class="vf-sheet-text">Les joueurs et les rôles de cette partie seront supprimés.</p>' +
          '<button class="vf-btn-sm" style="background:transparent;color:var(--vf-vilains);border:1px solid var(--vf-vilains)" data-action="confirm-reset">Recommencer</button>' +
          '<button class="vf-btn-text" data-action="close-sheet">Annuler</button></div>';
      case 'role':
      case 'result':
        var isRes = sheet.kind === 'result';
        var rid = isRes ? ps[sheet.pid].role : sheet.rid;
        var r = ROLES[rid];
        var note = isRes ? 'Garde cette information pour toi.'
          : r.item ? '*** Connu de tous · objet : ' + r.item
          : r.needsBox ? 'Objets dans une boîte préparée à l\'avance' + boxItemsText(r) + '.'
          : r.notDealt ? 'N\'est jamais distribué : apparaît en cours de partie.' : '';
        return '<div class="vf-sheet-body" style="padding-top:12px;gap:12px">' +
          '<span class="vf-eyebrow">' + (isRes ? escapeAttr(ps[sheet.pid].name) + (ps[sheet.pid].dead ? ' (éliminé(e)) est' : ' est') : CAMP_LABEL[r.camp]) + '</span>' +
          badge(rid, 72) +
          '<h2 style="margin:0;font-size:26px;line-height:1.1;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">' + r.name + '</h2>' +
          '<span style="width:40px;height:1px;background:var(--vf-gold)"></span>' +
          '<p style="margin:0;font-size:15px;line-height:1.55;text-wrap:pretty">' + r.description + '</p>' +
          (note ? '<p style="margin:0;color:var(--vf-muted);font-size:13px">' + note + '</p>' : '') +
          '<button class="vf-btn-sm" style="margin-top:4px;font-size:14px" data-action="close-sheet">' + (isRes ? 'Compris' : 'Fermer') + '</button></div>';
    }
    return '';
  }

  function renderSheet() {
    if (!sheet) { sheetEl.innerHTML = ''; return; }
    sheetEl.innerHTML = '<div class="vf-scrim" data-action="close-sheet"></div>' +
      '<div class="vf-sheet"><div class="vf-sheet-handle"><span></span></div>' + sheetInner() + '</div>';
  }
  function openSheet(s) { sheet = s; renderSheet(); }
  function closeSheet() { sheet = null; renderSheet(); }

  // ---- Espace secret d'un joueur ----
  function heraldRemaining() { return state.hl ? state.hl + HERALD_MS - nowMs() : HERALD_MS; }
  function timerView() {
    var rem = heraldRemaining();
    var alert = rem <= 0;
    var pct = Math.max(0, Math.min(1, rem / HERALD_MS)) * 100;
    var t = Math.max(0, Math.floor(rem / 1000));
    return {
      text: alert ? 'Rappel !' : Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'),
      color: alert ? 'var(--vf-vilains)' : 'var(--vf-text)',
      ring: alert ? 'var(--vf-vilains) 100%, var(--vf-vilains) 0' : 'var(--vf-gold) ' + pct + '%, var(--vf-border) 0'
    };
  }
  // Compte a rebours de la Succube : le bouton s'active tout seul a la fin.
  function updateSucWait() {
    var waits = [['vf-suc-wait', sucRemaining(state.suc && state.suc[state.space])],
                 ['vf-lg-wait', lgRemaining(state.lg && state.lg[state.space])]];
    for (var k = 0; k < waits.length; k++) {
      var el = document.getElementById(waits[k][0]);
      if (!el) continue;
      if (waits[k][1] <= 0) { render(); return; }
      el.textContent = clock(waits[k][1]);
    }
  }
  function updateTimer() {
    var ring = document.getElementById('vf-timer-ring');
    if (!ring) return;
    var v = timerView();
    ring.style.background = 'conic-gradient(' + v.ring + ')';
    var num = document.getElementById('vf-timer-num');
    num.textContent = v.text;
    num.style.color = v.color;
  }

  function powerHtml(idx, role) {
    var ps = state.players;
    var others = ps.map(function (p, i) { return i; }).filter(function (i) { return i !== idx; });
    if (role.special === 'priest_reveal') {
      var left = 2 - state.pr.length;
      var slots = [0, 1].map(function (n) {
        var id = state.pr[n];
        if (id === undefined || !ps[id]) {
          return '<button data-action="priest-open" class="vf-tile-btn" style="height:150px;justify-content:center;gap:8px;padding:10px;border-color:rgba(227,178,94,0.5)">' +
            '<span style="color:var(--vf-gold)">' + icon('visibility', 30) + '</span>' +
            '<span style="font-size:13px;font-weight:700;color:var(--vf-gold);letter-spacing:0.06em">Consulter</span></button>';
        }
        var rr = ROLES[ps[id].role];
        return '<button data-action="result-open" data-arg="' + id + '" class="vf-tile-btn" style="height:150px;justify-content:center;gap:8px;padding:10px">' +
          badge(ps[id].role, 40) + '<span style="font-size:14px;font-weight:700;text-decoration:' + (ps[id].dead ? 'line-through' : 'none') + '">' + escapeAttr(ps[id].name) + '</span>' +
          (ps[id].dead ? '<span style="font-size:11px;color:var(--vf-muted);font-weight:600;margin-top:-4px">Éliminé(e)</span>' : '') +
          '<span style="font-size:12px;color:' + CAMP_COLOR[rr.camp] + ';text-transform:uppercase;letter-spacing:0.08em;font-weight:700">' + rr.name + '</span></button>';
      }).join('');
      return '<div style="display:flex;flex-direction:column;gap:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline"><h3 class="vf-h3">Consultation</h3>' +
        '<span style="font-size:13px;color:var(--vf-muted)">' + (left > 0 ? left + ' restante' + (left > 1 ? 's' : '') : 'Terminée') + '</span></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' + slots + '</div></div>';
    }
    if (role.special === 'fee_protect') {
      var prot = state.fee !== null && ps[state.fee] ? ps[state.fee] : null;
      return '<div style="display:flex;flex-direction:column;gap:12px"><h3 class="vf-h3">Jeton de bénédiction</h3>' +
        '<button data-action="fee-open" class="vf-tile-btn" style="flex-direction:row;gap:14px;padding:14px 16px;text-align:left;border-color:' + (prot ? 'var(--vf-gold)' : 'var(--vf-border)') + '">' +
        '<span style="flex:none;width:48px;height:48px;border-radius:999px;border:1px solid var(--vf-gold);display:flex;align-items:center;justify-content:center;color:var(--vf-gold)">' + icon('shield', 24) + '</span>' +
        '<span style="flex:1;display:flex;flex-direction:column;gap:2px"><span style="font-size:16px;font-weight:700">' + (prot ? 'Protégé : ' + escapeAttr(prot.name) : 'Aucune protection active') + '</span>' +
        '<span style="font-size:13px;color:var(--vf-muted);line-height:1.4">' + (prot ? 'Expire quand le Hérault relance le rappel.' : 'Touche pour bénir un joueur.') + '</span></span>' +
        '<span style="color:var(--vf-muted)">' + icon('chevron_right', 22) + '</span></button></div>';
    }
    if (role.special === 'spy_notes') {
      var n = Object.keys(state.spy).length;
      var pips = [0, 1, 2, 3, 4, 5].map(function (k) {
        return '<span style="flex:1;height:4px;border-radius:2px;transition:background .3s ease;background:' + (k < n ? 'var(--vf-gold)' : 'var(--vf-border)') + '"></span>';
      }).join('');
      var rows = others.map(function (i) {
        var g = state.spy[i];
        return '<button data-action="spy-open" data-arg="' + i + '" class="vf-tile-btn" style="border-radius:10px;padding:10px 12px;align-items:flex-start;gap:2px;text-align:left;min-height:56px;border-color:' + (g ? 'rgba(227,178,94,0.5)' : 'var(--vf-border)') + '">' +
          '<span style="font-size:14px;font-weight:700;text-decoration:' + (ps[i].dead ? 'line-through' : 'none') + '">' + escapeAttr(ps[i].name) + '</span>' +
          '<span style="font-size:12px;font-weight:600;color:' + (g ? 'var(--vf-gold)' : 'var(--vf-muted)') + '">' + (g ? ROLES[g].name : 'Deviner…') + '</span></button>';
      }).join('');
      return '<div style="display:flex;flex-direction:column;gap:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline"><h3 class="vf-h3">Carnet secret</h3><span style="font-size:13px;color:var(--vf-gold);font-weight:700">' + n + ' / 6</span></div>' +
        '<p style="margin:0;color:var(--vf-muted);font-size:13px;line-height:1.45">Identifie sans erreur le rôle de 6 joueurs d\'ici la fin pour gagner seul.</p>' +
        '<div style="display:flex;gap:6px">' + pips + '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' + rows + '</div></div>';
    }
    if (role.id === 'herault') {
      var v = timerView();
      return '<div style="display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center"><h3 class="vf-h3">Rappel du village</h3>' +
        '<div id="vf-timer-ring" style="width:200px;height:200px;border-radius:999px;background:conic-gradient(' + v.ring + ');display:flex;align-items:center;justify-content:center">' +
        '<div style="width:184px;height:184px;border-radius:999px;background:var(--vf-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">' +
        '<span id="vf-timer-num" style="font-size:46px;font-weight:800;font-variant-numeric:tabular-nums;color:' + v.color + '">' + v.text + '</span>' +
        '<span style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:var(--vf-muted)">avant le vote</span></div></div>' +
        '<p style="margin:0;color:var(--vf-muted);font-size:14px;line-height:1.45;max-width:300px">Toutes les 30 minutes, lance la chanson signal pour réunir le village.</p>' +
        '<button class="vf-btn-sm" style="margin-top:0" data-action="reset-timer">Sonner le cor · relancer</button></div>';
    }
    if (role.id === 'vampire') {
      var used = state.conv;
      return '<div style="display:flex;flex-direction:column;gap:12px"><h3 class="vf-h3">Morsure</h3>' +
        '<button ' + (used ? 'disabled' : 'data-action="vamp-open"') + ' class="vf-tile-btn" style="flex-direction:row;gap:14px;padding:14px 16px;text-align:left;border-color:' + (used ? 'var(--vf-border)' : 'rgba(227,178,94,0.5)') + ';opacity:' + (used ? 0.6 : 1) + '">' +
        '<span style="flex:none;width:48px;height:48px;border-radius:999px;border:1px solid var(--vf-gold);display:flex;align-items:center;justify-content:center;color:var(--vf-gold)">' + icon('bloodtype', 24) + '</span>' +
        '<span style="flex:1;display:flex;flex-direction:column;gap:2px"><span style="font-size:16px;font-weight:700">' + (used ? 'Conversion utilisée' : 'Convertir un joueur') + '</span>' +
        '<span style="font-size:13px;color:var(--vf-muted);line-height:1.4">' + (used ? 'De nouveau disponible quand le Hérault relance le rappel.' : 'Un joueur devient Rejeton vampire (une fois par manche).') + '</span></span>' +
        (used ? '' : '<span style="color:var(--vf-muted)">' + icon('chevron_right', 22) + '</span>') + '</button></div>';
    }
    if (role.special === 'shaman_dead') {
      var deadIds = ps.map(function (p, i) { return i; }).filter(function (i) { return ps[i].dead && i !== idx; });
      var deadBody = deadIds.length
        ? '<div class="vf-grid3">' + deadIds.map(function (i) {
          var rr = ROLES[ps[i].role];
          return '<div style="border-radius:10px;border:1px solid var(--vf-border);background:var(--vf-card);padding:10px 6px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center">' +
            badge(ps[i].role, 32) +
            '<span style="font-size:13px;font-weight:700">' + escapeAttr(ps[i].name) + '</span>' +
            '<span style="font-size:11px;color:' + CAMP_COLOR[rr.camp] + ';font-weight:600">' + rr.name + '</span></div>';
        }).join('') + '</div>'
        : '<p style="margin:0;color:var(--vf-muted);font-size:14px;line-height:1.45;text-align:center">Personne n\'est encore mort. Reviens voir quand un joueur sera éliminé.</p>';
      return '<div style="display:flex;flex-direction:column;gap:12px"><div style="display:flex;justify-content:space-between;align-items:baseline"><h3 class="vf-h3">Les morts</h3>' +
        '<span style="font-size:13px;color:var(--vf-muted)">' + deadIds.length + ' joueur' + (deadIds.length > 1 ? 's' : '') + '</span></div>' + deadBody + '</div>';
    }
    if (role.special === 'werewolf_devour') {
      var lrem = lgRemaining(state.lg && state.lg[idx]);
      var lbtn = ps[idx].dead ? '' : lrem > 0
        ? '<button class="vf-btn-sm" style="margin-top:0;background:var(--vf-vilains);opacity:0.45;cursor:default" disabled>Dévorer un joueur · dans <span id="vf-lg-wait">' + clock(lrem) + '</span></button>'
        : '<button class="vf-btn-sm" style="margin-top:0;background:var(--vf-vilains)" data-action="lg-open">Dévorer un joueur</button>';
      return '<div style="display:flex;flex-direction:column;gap:12px"><h3 class="vf-h3">Dévoration</h3>' +
        '<p style="margin:0;color:var(--vf-muted);font-size:14px;line-height:1.45;text-align:center">Une fois toutes les 40 minutes, tu peux dévorer un joueur : il est déclaré mort. Ta première dévoration est possible après 20 minutes de jeu. Ta victime n\'est éliminée que si elle porte une gommette rouge posée par toi : récupère-les dans ta boîte.</p>' + lbtn + '</div>';
    }
    if (role.special === 'succube_target') {
      var se = state.suc && state.suc[idx];
      var starget = se && ps[se.t] ? ps[se.t] : null;
      var alive = !ps[idx].dead;
      var scard;
      if (starget && !starget.dead) {
        scard = '<div style="display:flex;align-items:center;gap:14px;border:1px solid var(--vf-gold);border-radius:12px;padding:14px 16px;text-align:left">' +
          '<span style="flex:none;width:48px;height:48px;border-radius:999px;border:1px solid var(--vf-gold);display:flex;align-items:center;justify-content:center;color:var(--vf-gold)">' + icon('lock', 24) + '</span>' +
          '<span style="flex:1;display:flex;flex-direction:column;gap:2px"><span style="font-size:16px;font-weight:700">Cible : ' + escapeAttr(starget.name) + '</span>' +
          '<span style="font-size:13px;color:var(--vf-muted);line-height:1.4">Verrouillée jusqu\'à sa mort ou son bannissement. Elle sait qu\'elle est ciblée.</span></span></div>' +
          (!alive ? '' : sucRemaining(se) > 0
            ? '<button class="vf-btn-sm" style="margin-top:0;background:var(--vf-vilains);opacity:0.45;cursor:default" disabled>Mettre fin à sa vie · dans <span id="vf-suc-wait">' + clock(sucRemaining(se)) + '</span></button>' +
              '<p style="margin:0;color:var(--vf-muted);font-size:13px;text-align:center">Possible 20 minutes après le choix de la cible.</p>'
            : '<button class="vf-btn-sm" style="margin-top:0;background:var(--vf-vilains)" data-action="suc-kill-open">Mettre fin à sa vie</button>');
      } else if (se && se.done) {
        scard = '<p style="margin:0;color:var(--vf-muted);font-size:14px;line-height:1.45;text-align:center">Tu as mis fin à la vie de ta cible : tu ne peux plus choisir d\'autre cible.</p>';
      } else {
        scard = '<p style="margin:0;color:var(--vf-muted);font-size:14px;line-height:1.45;text-align:center">' +
          (starget ? escapeAttr(starget.name) + ' est mort(e) : tu peux choisir une nouvelle cible.' : 'Aucune cible pour l\'instant. Une fois choisie, tu ne pourras plus en changer tant qu\'elle est en vie.') + '</p>' +
          (alive ? '<button class="vf-btn-sm" style="margin-top:0" data-action="suc-open">Choisir une cible</button>' : '');
      }
      return '<div style="display:flex;flex-direction:column;gap:12px"><h3 class="vf-h3">Cible</h3>' + scard + '</div>';
    }
    if (role.special === 'devil_omniscient') {
      var rows2 = others.map(function (i) {
        var rr = ROLES[ps[i].role];
        return '<div style="border-radius:10px;border:1px solid var(--vf-border);background:var(--vf-card);padding:10px 6px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;opacity:' + (ps[i].dead ? 0.4 : 1) + '">' +
          badge(ps[i].role, 32) +
          '<span style="font-size:13px;font-weight:700;text-decoration:' + (ps[i].dead ? 'line-through' : 'none') + '">' + escapeAttr(ps[i].name) + '</span>' +
          '<span style="font-size:11px;color:' + CAMP_COLOR[rr.camp] + ';font-weight:600">' + rr.name + '</span></div>';
      }).join('');
      return '<div style="display:flex;flex-direction:column;gap:12px"><h3 class="vf-h3">Tu connais tout le monde</h3><div class="vf-grid3">' + rows2 + '</div></div>';
    }
    return '';
  }

  function askById(id) {
    var list = state.ask || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function sucRemaining(e) { return e && e.at ? e.at + Game.SUC_DELAY_MS - nowMs() : 0; }
  // Premiere dévoration : 20 min apres le debut de la partie ; ensuite 40 min apres la precedente.
  function lgRemaining(e) {
    if (e) return e.at + Game.LG_DELAY_MS - nowMs();
    return state.start ? state.start + Game.LG_FIRST_DELAY_MS - nowMs() : 0;
  }
  function clock(ms) {
    var t = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }

  // Une Succube en vie a verrouille ce joueur (vivant) comme cible.
  function targetedBySuccube(idx) {
    if (state.players[idx].dead) return false;
    return Object.keys(state.suc || {}).some(function (k) {
      var e = state.suc[k], s = state.players[k];
      return e.t === idx && !e.done && s && !s.dead && s.role === 'succube';
    });
  }

  function renderSpace() {
    var idx = state.space;
    var owner = state.players[idx];
    if (!owner) return renderHub();
    var role = ROLES[owner.role];
    var power = powerHtml(idx, role);

    var item = '';
    if (role.item) {
      item = '<div style="display:flex;align-items:center;gap:14px;border:1px dashed rgba(227,178,94,0.6);border-radius:12px;padding:14px 16px">' +
        '<span style="color:var(--vf-gold)">' + icon('workspace_premium', 28) + '</span>' +
        '<span style="display:flex;flex-direction:column;gap:2px"><span style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:var(--vf-muted)">Ton objet</span>' +
        '<span style="font-size:18px;font-weight:700;color:var(--vf-gold)">' + role.item + '</span></span></div>';
    } else if (role.needsBox) {
      var box = boxNumberOf(owner);
      item = '<div style="display:flex;align-items:center;gap:16px;border:1px dashed rgba(227,178,94,0.6);border-radius:12px;padding:12px 16px">' +
        '<span style="flex:none;width:56px;height:56px;border-radius:10px;border:1px solid var(--vf-gold);display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--vf-gold)">' +
        '<span style="font-size:10px;font-weight:700;letter-spacing:0.1em">N°</span><span style="font-size:24px;font-weight:800;line-height:1">' + box + '</span></span>' +
        '<span style="display:flex;flex-direction:column;gap:2px"><span style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:var(--vf-muted)">Tes objets</span>' +
        '<span style="font-size:15px;line-height:1.4">Dans la boîte n° ' + box + boxItemsText(role) + ', à récupérer en secret.</span></span></div>';
    }

    return '<div class="vf-hub" style="' + enterAnim() + '">' +
      '<div class="vf-space-head"><span style="display:flex;flex-direction:column;gap:2px">' +
        '<span style="font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:var(--vf-muted)">Espace secret</span>' +
        '<span style="font-size:17px;font-weight:800;letter-spacing:0.06em">' + escapeAttr(owner.name) + '</span></span>' +
        '<button class="vf-refermer" data-action="close-space">' + icon('lock', 18) + 'Refermer</button></div>' +
      '<div class="vf-hub-body">' +
        (owner.dead ? '<div class="vf-dead-note">' + icon('skull', 22) + 'Tu es éliminé(e). Tu ne parles plus et ne votes plus.</div>' : '') +
        (targetedBySuccube(idx) ? '<div class="vf-conv-note">' + icon('visibility', 22) + 'La Succube t\'a choisi(e) comme cible : elle peut mettre fin à tes jours à tout moment.</div>' : '') +
        (owner.converted ? '<div class="vf-conv-note">' + icon('bloodtype', 22) + 'Tu as été transformé(e) en Rejeton vampire : tu perds tes anciens pouvoirs et tu rejoins le camp du mal.</div>' : '') +
        '<div class="vf-hero">' +
          '<span style="font-size:11px;font-weight:700;letter-spacing:0.24em;color:var(--vf-gold);text-transform:uppercase">' + CAMP_LABEL[role.camp] + (role.known ? ' · ***' : '') + '</span>' +
          badge(role.id, 80) +
          '<h2 style="margin:0;font-size:28px;line-height:1.1;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">' + role.name + '</h2>' +
          '<span style="width:40px;height:1px;background:var(--vf-gold)"></span>' +
          '<p style="margin:0;font-size:15px;line-height:1.55;text-wrap:pretty">' + role.description + '</p></div>' +
        item +
        (power ? '<div style="display:flex;align-items:center;gap:10px"><span style="flex:1;height:1px;background:rgba(227,178,94,0.25)"></span>' +
          '<span style="font-size:11px;font-weight:800;letter-spacing:0.24em;color:var(--vf-gold);text-transform:uppercase">✦ Pouvoir ✦</span>' +
          '<span style="flex:1;height:1px;background:rgba(227,178,94,0.25)"></span></div>' + power : '') +
      '</div></div>';
  }

  // ---- Fin de partie ----
  function spyResult() {
    var spyIdx = -1;
    state.players.forEach(function (p, i) { if (p.role === 'espion') spyIdx = i; });
    if (spyIdx < 0) return null;
    var correct = Object.keys(state.spy).filter(function (pid) {
      return state.players[pid] && state.players[pid].role === state.spy[pid];
    }).length;
    return { idx: spyIdx, correct: correct, win: correct >= 6 };
  }

  function renderRecap() {
    var ps = state.players;
    var spy = spyResult();
    var spyWin = !!(spy && spy.win);
    var title, sub;
    if (spyWin) {
      title = 'L\'Espion l\'emporte seul';
      sub = escapeAttr(ps[spy.idx].name) + ' a deviné ' + spy.correct + ' rôles sans erreur.';
    } else if (state.winner) {
      title = WIN_TITLE[state.winner];
      sub = 'Félicitations aux vainqueurs !';
    } else {
      title = 'Qui l\'emporte ?';
      sub = 'Désigne le camp vainqueur.';
    }

    var chips = spyWin ? '' : '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">' +
      CAMPS.map(function (c) {
        var on = state.winner === c;
        return '<button class="vf-chip" data-action="set-winner" data-arg="' + c + '" style="border:1px solid ' + CAMP_COLOR[c] + ';color:' + (on ? 'var(--vf-bg)' : CAMP_COLOR[c]) + ';background:' + (on ? CAMP_COLOR[c] : 'transparent') + '">' + CAMP_LABEL[c] + '</button>';
      }).join('') + '</div>';

    var order = [];
    CAMPS.forEach(function (c) {
      ps.forEach(function (p, i) { if (ROLES[p.role].camp === c) order.push(i); });
    });
    var cascade = enter !== 'none';
    var cards = order.map(function (i, k) {
      var p = ps[i], rr = ROLES[p.role];
      var winning = spyWin ? (spy.idx === i) : state.winner === rr.camp;
      var border = winning ? (spyWin ? 'var(--vf-gold)' : CAMP_COLOR[rr.camp]) : 'var(--vf-border)';
      return '<div style="border-radius:10px;border:1px solid ' + border + ';background:var(--vf-card);padding:12px 6px 10px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;opacity:' + (p.dead ? 0.5 : 1) + ';' +
        (cascade ? 'animation:vfDeal .45s cubic-bezier(.2,.8,.2,1) both;animation-delay:' + (k * 50) + 'ms' : '') + '">' +
        badge(p.role, 36) +
        '<span style="font-size:13px;font-weight:700;text-decoration:' + (p.dead ? 'line-through' : 'none') + '">' + escapeAttr(p.name) + '</span>' +
        '<span style="font-size:11px;font-weight:600;color:' + CAMP_COLOR[rr.camp] + '">' + rr.name + '</span>' +
        (p.dead && p.cause ? '<span style="font-size:10px;color:var(--vf-muted)">' + causeLabel(p.cause) + '</span>' : '') + '</div>';
    }).join('');

    return '<div class="vf-scroll" style="justify-content:flex-start;align-items:stretch;padding:8px 20px 28px;gap:18px;' + enterAnim() + '">' +
      '<button class="vf-icon-btn" style="margin-left:-8px;flex:none" data-action="recap-back" aria-label="Retour">' + icon('arrow_back', 24) + '</button>' +
      '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center">' +
        '<span style="font-size:12px;font-weight:700;letter-spacing:0.3em;color:var(--vf-muted);text-transform:uppercase">Fin de partie</span>' +
        '<h1 style="margin:0;font-size:28px;line-height:1.15;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:var(--vf-gold);text-wrap:balance">' + title + '</h1>' +
        '<span style="width:40px;height:1px;background:var(--vf-gold)"></span>' +
        '<p style="margin:0;color:var(--vf-muted);font-size:14px">' + sub + '</p>' + chips + '</div>' +
      '<div class="vf-grid3">' + cards + '</div>' +
      '<button class="vf-btn-sm" style="flex:none;font-size:14px;letter-spacing:0.12em" data-action="new-game">Nouvelle partie</button></div>';
  }

  // ==== Causes de mort ====
  var CAUSES = [
    { id: 'devore', label: 'Dévoré', by: 'Loup-garou', icon: 'pets' },
    { id: 'brule', label: 'Brûlé', by: 'Démon', icon: 'local_fire_department' },
    { id: 'asphyxie', label: 'Asphyxié', by: 'Succube', icon: 'air' },
    { id: 'pendu', label: 'Pendu', by: 'vote', icon: 'gavel' },
    { id: 'empoisonne', label: 'Empoisonné', by: 'Sorcière', icon: 'science' }
  ];
  function causeLabel(id) {
    if (id === 'bannissement') return 'Banni (mort du Roi)';
    if (id === 'lien') return 'Mort avec les Démons';
    for (var i = 0; i < CAUSES.length; i++) {
      if (CAUSES[i].id === id) return CAUSES[i].label + ' (' + CAUSES[i].by + ')';
    }
    return '';
  }

  // ==== Ecran : personnages possibles (paquet personnalise) ====
  // Le paquet personnalise est une LISTE de personnages possibles : elle peut
  // depasser le nombre de joueurs, la partie tire alors au hasard dedans.
  var dk = null; // brouillon de l'ecran (transitoire)

  var dealtIds = Game.dealtIds;
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var validateCounts = Game.validateCounts;

  function openDeck() {
    var c = currentCounts();
    var counts = {};
    dealtIds().forEach(function (id) { counts[id] = c[id] || 0; });
    dk = { tab: 'list', counts: counts };
    go('deck', 'f');
  }

  function stepper(idText, value, action, arg) {
    return '<div class="vf-stepper">' +
      '<button class="vf-mini" data-action="' + action + '" data-arg="' + arg + ':-1" aria-label="Moins">−</button>' +
      '<span class="vf-dc-n" id="' + idText + '">' + value + '</span>' +
      '<button class="vf-mini" data-action="' + action + '" data-arg="' + arg + ':1" aria-label="Plus">+</button></div>';
  }

  function deckGroups(rowFn, ids) {
    return CAMPS.map(function (camp) {
      var list = ids.filter(function (id) { return ROLES[id].camp === camp; });
      if (!list.length) return '';
      return '<div style="display:flex;flex-direction:column;gap:2px">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><span class="vf-group-title" style="color:' + CAMP_COLOR[camp] + '">' + CAMP_LABEL[camp] + '</span>' +
        '<span style="flex:1;height:1px;background:var(--vf-border)"></span></div>' + list.map(rowFn).join('') + '</div>';
    }).join('');
  }

  function deckTabBody() {
    if (dk.tab === 'boxes') {
      var present = dealtIds().filter(function (id) { return dk.counts[id] > 0 && ROLES[id].needsBox; });
      if (!present.length) {
        return '<p class="vf-body-sm" style="max-width:none;text-align:center">Aucun personnage de la liste n\'a d\'objets à ranger dans une boîte.</p>';
      }
      return '<p class="vf-body-sm" style="max-width:none;text-align:center">Numéro de la boîte de chaque personnage. Laisse vide pour le numéro automatique (affiché dans la case).</p>' +
        present.map(function (id) {
          return '<div class="vf-dc-row">' + badge(id, 30, 'var(--vf-bg)') + '<span class="vf-dc-name">' + ROLES[id].name + '</span>' +
            '<input class="vf-box-input" type="text" inputmode="numeric" maxlength="6" placeholder="' + autoBox(id) + '" data-box="' + id + '" value="' + escapeAttr(state.boxes[id] || '') + '"></div>';
        }).join('');
    }
    return '<p class="vf-body-sm" style="max-width:none;text-align:center">Choisis les personnages qui peuvent apparaître. La liste peut dépasser le nombre de joueurs (' + state.count + ') : les cartes sont tirées au hasard parmi eux.</p>' +
      deckGroups(function (id) {
        return '<div class="vf-dc-row">' + badge(id, 30, 'var(--vf-bg)') + '<span class="vf-dc-name">' + ROLES[id].name + '</span>' +
          stepper('vf-dc-' + id, dk.counts[id], 'deck-step', id) + '</div>';
      }, dealtIds());
  }

  function renderDeck() {
    if (!dk) return renderSetup();
    var err = validateCounts(dk.counts);
    var tabs = [['list', 'Personnages'], ['boxes', 'Boîtes']].map(function (t) {
      var on = dk.tab === t[0];
      return '<button data-action="deck-tab" data-arg="' + t[0] + '" style="appearance:none;border:none;background:none;flex:1;height:44px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:' + (on ? 'var(--vf-gold)' : 'var(--vf-muted)') + ';border-bottom:2px solid ' + (on ? 'var(--vf-gold)' : 'transparent') + ';margin-bottom:-1px">' + t[1] + '</button>';
    }).join('');
    return '<div class="vf-page" style="' + enterAnim() + '">' +
      '<button class="vf-icon-btn" data-action="deck-back" aria-label="Retour">' + icon('arrow_back', 24) + '</button>' +
      '<div class="vf-scroll" style="justify-content:flex-start;gap:18px;padding:4px 12px 16px">' +
        '<h1 class="vf-h1" style="text-align:center">Personnages<br>possibles</h1>' +
        '<div style="display:flex;border-bottom:1px solid var(--vf-border);align-self:stretch;flex:none">' + tabs + '</div>' +
        '<div style="align-self:stretch;display:flex;flex-direction:column;gap:14px">' + deckTabBody() + '</div>' +
      '</div>' +
      '<div style="flex:none;padding:12px 12px 0;display:flex;flex-direction:column;gap:8px;align-items:stretch">' +
        '<span id="vf-deck-error" class="vf-error" style="text-align:center;min-height:18px">' + err + '</span>' +
        '<button id="vf-deck-ok" class="vf-btn-gold" style="opacity:' + (err ? 0.4 : 1) + '" data-action="deck-ok">Valider · <span id="vf-deck-total">' + sumCounts(dk.counts) + '</span> possibles</button>' +
      '</div></div>';
  }

  // Met a jour les indicateurs sans re-rendre (evite de perdre la position de defilement).
  function refreshDeckStatus() {
    var err = validateCounts(dk.counts);
    document.getElementById('vf-deck-error').textContent = err;
    document.getElementById('vf-deck-total').textContent = sumCounts(dk.counts);
    document.getElementById('vf-deck-ok').style.opacity = err ? 0.4 : 1;
  }

  function deckStep(arg) {
    var p = arg.split(':');
    var id = p[0];
    dk.counts[id] = clamp((dk.counts[id] || 0) + parseInt(p[1], 10), 0, 10);
    document.getElementById('vf-dc-' + id).textContent = dk.counts[id];
    refreshDeckStatus();
  }
  function deckOk() {
    if (validateCounts(dk.counts)) return;
    dispatch({ type: 'custom-set', counts: dk.counts }, function (r) {
      if (!r.err) go('setup', 'b');
    });
  }

  function soldierIds() { return Game.soldierIds(state.players); }

  // --- Interactions ---
  function drawCard() {
    var input = document.getElementById('vf-name');
    var name = input ? input.value.trim() : '';
    state.name = name;
    dispatch({ type: 'draw', name: name }, function (r) {
      if (r.err) {
        state.err = r.err === 'dup' || r.err === 'offline' || r.err === 'full' ? r.err : 'empty';
        save(); render();
        var again = document.getElementById('vf-name');
        if (again) again.focus();
        return;
      }
      go('reveal', 'f', { cur: r.idx, name: '', err: '', flipped: false, revealAt: null });
    });
  }

  function onClick(e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    var arg = el.getAttribute('data-arg');

    switch (action) {
      case 'ob-skip':
        go('setup', 'f');
        break;
      case 'ob-next':
        if (state.ob < 2) { state.ob += 1; save(); render(); }
        else go('setup', 'f');
        break;
      case 'back-onboard':
        go('onboard', 'b', { ob: 2 });
        break;
      case 'setup-back':
        go('onboard', 'b', { ob: 2 });
        break;
      case 'count-dec':
        dispatch({ type: 'count', delta: -1 });
        break;
      case 'count-inc':
        dispatch({ type: 'count', delta: 1 });
        break;
      case 'start-pioche':
        dispatch({ type: 'start-pioche' });
        break;
      case 'pioche-back':
        dispatch({ type: 'back-setup' });
        break;
      case 'draw':
        drawCard();
        break;
      case 'flip':
        flipCard();
        break;
      case 'next-player':
        nextPlayer();
        break;
      case 'to-hub':
        dispatch({ type: 'to-hub' });
        break;

      // --- Personnalisation du paquet ---
      case 'open-deck': openDeck(); break;
      case 'custom-reset': dispatch({ type: 'custom-reset' }); break;
      case 'deck-back': go('setup', 'b'); break;
      case 'deck-tab': dk.tab = arg; render(); break;
      case 'deck-step': deckStep(arg); break;
      case 'deck-ok': deckOk(); break;

      // --- Hub ---
      case 'hub-tab':
        state.tab = arg; save(); closeSheet(); render();
        break;
      case 'roles-view':
        state.rview = arg; save(); render();
        break;
      case 'role-detail':
        openSheet({ kind: 'role', rid: arg });
        break;
      case 'open-player':
        openSheet({ kind: 'player', pid: +arg });
        break;
      case 'toggle-player':
        var tpid = sheet.pid;
        if (state.players[tpid].dead) {
          dispatch({ type: 'revive', pid: tpid }, function () { closeSheet(); });
        } else {
          dispatch({ type: 'kill-attempt', pid: tpid }, function (r) {
            if (r.saved) openSheet({ kind: 'player', pid: tpid, saved: true });
            else if (r.needCause) openSheet({ kind: 'cause', pid: tpid });
            else closeSheet();
          });
        }
        break;
      case 'cause-pick':
        dispatch({ type: 'kill', pid: sheet.pid, cause: arg }, function (r) {
          if (r.err === 'devil' || r.err === 'offline') return; // la feuille reste ouverte
          if (r.followUp) openSheet(r.followUp);
          else closeSheet();
        });
        break;
      case 'pardon-player':
        var gpid = sheet.pid;
        dispatch({ type: 'pardon', pid: gpid }, function (r) {
          if (!r.err) openSheet({ kind: 'pardon', pid: gpid });
        });
        break;
      case 'ban-soldiers':
        dispatch({ type: 'ban-soldiers' }, function () { closeSheet(); });
        break;
      case 'vamp-open':
        if (!state.conv) openSheet({ kind: 'vamp' });
        break;
      case 'vamp-pick':
        dispatch({ type: 'vamp', pid: +arg }, function () { closeSheet(); });
        break;
      case 'ask-end':
        openSheet({ kind: 'end' });
        break;
      case 'confirm-end':
        dispatch({ type: 'end' }, function () { closeSheet(); });
        break;
      case 'ask-reset':
        openSheet({ kind: 'reset' });
        break;
      case 'confirm-reset':
      case 'new-game':
        dispatch({ type: 'new-game' }, function () { closeSheet(); });
        break;
      case 'close-sheet':
        closeSheet();
        break;
      case 'recap-back':
        dispatch({ type: 'recap-back' });
        break;
      case 'set-winner':
        dispatch({ type: 'set-winner', camp: arg });
        break;

      // --- Espaces secrets ---
      case 'ask-space':
        openSheet({ kind: 'confirm', pid: +arg });
        break;
      case 'open-space':
        var target = +arg;
        curtain('Espace de ' + escapeAttr(state.players[target].name), 'lock_open', function () {
          closeSheet();
          go('space', 'fade', { space: target });
        });
        break;
      case 'close-space':
        curtain('Espace refermé', 'lock', function () {
          go('hub', 'fade', { tab: 'secret', space: null });
        });
        break;
      case 'priest-open':
        if (state.pr.length < 2) openSheet({ kind: 'priest' });
        break;
      case 'priest-pick':
        var seen = +arg;
        dispatch({ type: 'priest-pick', pid: seen }, function (r) {
          if (!r.err) openSheet({ kind: 'result', pid: seen });
        });
        break;
      case 'result-open':
        openSheet({ kind: 'result', pid: +arg });
        break;
      case 'fee-open':
        openSheet({ kind: 'fee' });
        break;
      case 'fee-pick':
        dispatch({ type: 'fee-pick', pid: +arg }, function () { closeSheet(); });
        break;
      case 'spy-open':
        openSheet({ kind: 'spy', pid: +arg });
        break;
      case 'spy-pick':
        dispatch({ type: 'spy-pick', pid: sheet.pid, role: arg }, function () { closeSheet(); });
        break;
      case 'reset-timer':
        dispatch({ type: 'reset-timer' }, function () { updateTimer(); });
        break;
      case 'ask-open':
        if (state.ask && state.ask.length) openSheet({ kind: 'devoured', id: state.ask[0].id });
        break;
      case 'lg-verdict':
        var vp = arg.split(':');
        dispatch({ type: 'lg-verdict', id: +vp[0], marked: vp[1] === '1' }, function (r) {
          if (r.saved) openSheet({ kind: 'info', icon: 'shield', title: escapeAttr(state.players[r.pid].name) + ' est protégé(e)',
            text: 'La Fée l\'a protégé(e) : elle survit et la protection est consommée.' });
          // Sinon rien : la feuille de la question se referme toute seule (onShared) et ne doit pas
          // masquer une annonce arrivée entre-temps (ex. bannir les Soldats).
        });
        break;
      case 'lg-open':
        openSheet({ kind: 'lg' });
        break;
      case 'lg-pick':
        openSheet({ kind: 'lg-confirm', pid: +arg });
        break;
      case 'lg-confirm':
        dispatch({ type: 'lg-kill', by: state.space, pid: +arg }, function (r) {
          if (r.err) closeSheet();
          else openSheet({ kind: 'info', icon: 'visibility_off', title: 'Dévoration lancée',
            text: escapeAttr(state.players[r.pid].name) + ' sera annoncé(e) comme dévoré(e) dans 1 minute, pour que personne ne fasse le lien avec toi. Les joueurs vérifieront alors la marque. Tu pourras dévorer de nouveau dans 40 minutes.' });
        });
        break;
      case 'suc-open':
        openSheet({ kind: 'suc' });
        break;
      case 'suc-pick':
        openSheet({ kind: 'suc-confirm', pid: +arg });
        break;
      case 'suc-confirm':
        dispatch({ type: 'suc-pick', by: state.space, pid: +arg }, function () { closeSheet(); });
        break;
      case 'suc-kill-open':
        openSheet({ kind: 'suc-kill' });
        break;
      case 'suc-kill':
        dispatch({ type: 'suc-kill', by: state.space }, function (r) {
          if (r.err) closeSheet();
          else openSheet({ kind: 'info', icon: 'visibility_off', title: 'Fin de vie lancée',
            text: escapeAttr(state.players[r.pid].name) + ' sera déclaré(e) mort(e) dans 1 minute, pour que personne ne fasse le lien avec toi. Tu ne peux plus choisir d\'autre cible.' });
        });
        break;
    }
  }

  root.addEventListener('click', onClick);

  // Garde la saisie du prenom sans re-rendre (evite de perdre le focus).
  root.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'vf-name') state.name = e.target.value;
    var boxRole = e.target && e.target.getAttribute && e.target.getAttribute('data-box');
    if (boxRole) dispatch({ type: 'box-set', role: boxRole, value: e.target.value });
  });
  root.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.id === 'vf-name') {
      e.preventDefault();
      drawCard();
    }
  });

  transport.start({ onState: onShared, onStatus: onStatus });
  if (!ready) render();
})();
