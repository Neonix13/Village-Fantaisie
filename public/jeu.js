(function () {
  'use strict';

  var STATE_KEY = 'vf-partie-v1';

  var ROLES = window.VF_ROLES || {};
  var PRIORITY = window.VF_PRIORITY || [];
  var BADGES = window.VF_BADGES || {};

  function defaultState() {
    return {
      screen: 'onboard',
      ob: 0,
      count: 8,
      deck: [],
      players: [],
      cur: null,
      flipped: false,
      revealAt: null,
      tab: 'village',
      rview: 'partie',
      space: null,
      pr: [],
      fee: null,
      spy: {},
      hl: null,
      winner: null
    };
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if (!raw) return defaultState();
      var parsed = JSON.parse(raw);
      // Par confidentialite / coherence au rechargement de page.
      if (parsed.screen === 'reveal') parsed.screen = 'pioche';
      if (parsed.screen === 'space') { parsed.screen = 'hub'; parsed.space = null; }
      return Object.assign(defaultState(), parsed);
    } catch (e) {
      return defaultState();
    }
  }

  var state = loadState();

  function save() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  // --- Blasons (SVG pre-rendus cote serveur depuis views/partials/role_badge.ejs) ---
  function badge(roleId, size) {
    var svg = BADGES[roleId];
    if (!svg) return '';
    var h = Math.round(size * 58 / 48);
    return svg.replace('<svg ', '<svg style="width:' + size + 'px;height:' + h + 'px;flex:none" ');
  }

  // --- Deck : port fidele de roles.js (PRIORITY + complement Villageois + shuffle) ---
  function shuffleArr(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  function buildDeck(n) {
    var deck = PRIORITY.slice(0, n);
    while (deck.length < n) deck.push('villageois');
    return shuffleArr(deck);
  }

  var root = document.getElementById('app');

  function render() {
    root.innerHTML = '<div class="vf-viewport"><div class="vf-frame">' + renderScreen() + '</div></div>';
  }

  function renderScreen() {
    switch (state.screen) {
      case 'onboard': return renderOnboard();
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
    if (state.ob === 0) {
      body = renderOnboardPage0();
    } else if (state.ob === 1) {
      body = renderOnboardPage1();
    } else {
      body = renderOnboardPage2();
    }

    var dots = [0, 1, 2].map(function (i) {
      return '<span class="vf-dot' + (i === state.ob ? ' is-active' : '') + '"></span>';
    }).join('');

    return '<div class="vf-onboard" style="animation:vfFade .3s ease-out both">' +
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
    var steps = [
      'Chacun son tour, isole-toi pour tirer ta carte, puis passe le téléphone.',
      'Pendant la partie, le téléphone reste au centre, sur le Village.',
      'Besoin de ton pouvoir ? Ouvre ton espace secret, puis referme-le avant de le rendre.'
    ];
    var stepsHtml = steps.map(function (text, i) {
      return '<div class="vf-step-row"><span class="vf-step-roman">' + OB_NUMERALS[i] + '</span><span class="vf-step-text">' + text + '</span></div>';
    }).join('');
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;align-self:stretch;animation:vfTab .3s ease-out both">' +
      '<h1 class="vf-h1">Un seul téléphone</h1>' +
      '<div class="vf-steps">' + stepsHtml + '</div>' +
      '</div>';
  }

  // --- Interactions ---
  function onClick(e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');

    if (action === 'ob-skip') {
      state.screen = 'setup';
      save(); render();
      return;
    }
    if (action === 'ob-next') {
      if (state.ob < 2) {
        state.ob += 1;
      } else {
        state.screen = 'setup';
      }
      save(); render();
      return;
    }
    if (action === 'back-onboard') {
      state.screen = 'onboard';
      state.ob = 2;
      save(); render();
      return;
    }
  }

  root.addEventListener('click', onClick);
  render();
})();
