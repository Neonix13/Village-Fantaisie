// --- Formulaires a bascule (radio "mode" + panneaux <valeur>-panel) ------
(function () {
  document.querySelectorAll('form').forEach(function (form) {
    var radios = form.querySelectorAll('input[name="mode"]');
    if (radios.length === 0) return;

    function sync() {
      var checked = form.querySelector('input[name="mode"]:checked');
      if (!checked) return;
      radios.forEach(function (r) {
        var panel = document.getElementById(r.value + '-panel');
        if (panel) panel.hidden = (r.value !== checked.value);
      });
    }

    radios.forEach(function (r) { r.addEventListener('change', sync); });
    sync();
  });
})();

// --- Steppers +/- (mode detaille de la composition du deck) --------------
(function () {
  document.querySelectorAll('.stepper').forEach(function (stepper) {
    var input = stepper.querySelector('input[type="number"]');
    stepper.querySelectorAll('.step-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var step = parseInt(btn.getAttribute('data-step'), 10);
        var min = parseInt(input.min, 10);
        var max = parseInt(input.max, 10);
        var val = (parseInt(input.value, 10) || 0) + step;
        input.value = Math.min(max, Math.max(min, val));
      });
    });
  });
})();

// --- Tableau de bord : confirmation avant de recommencer la partie -------
(function () {
  var form = document.getElementById('reset-form');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    if (!confirm('Tout recommencer ? Les joueurs et les roles de cette partie seront supprimes.')) {
      e.preventDefault();
    }
  });
})();

// --- Liste des joueurs : declarer une mort / gracier ----------------------
(function () {
  var aliveList = document.getElementById('alive-list');
  var deadList = document.getElementById('dead-list');
  if (!aliveList || typeof window.ADMIN_PARTY_ID === 'undefined') return;

  var base = '/admin/' + window.ADMIN_PARTY_ID + '/' + window.ADMIN_TOKEN;

  aliveList.addEventListener('click', function (e) {
    var killBtn = e.target.closest('.kill-btn');
    var causeBtn = e.target.closest('.cause-btn');
    var li = e.target.closest('li');
    if (!li) return;
    var playerId = li.getAttribute('data-player-id');

    if (killBtn) {
      killBtn.hidden = true;
      li.querySelector('.cause-buttons').hidden = false;
      return;
    }

    if (causeBtn) {
      var cause = causeBtn.getAttribute('data-cause');
      fetch(base + '/players/' + playerId + '/eliminate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'cause=' + encodeURIComponent(cause)
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.saved) {
            alert('Protege par la Fee - a survecu !');
            li.querySelector('.cause-buttons').hidden = true;
            li.querySelector('.kill-btn').hidden = false;
            return;
          }
          if (data.role_id === 'roi') {
            if (confirm('Le Roi est mort. Reveler et eliminer les Soldats maintenant ?')) {
              fetch(base + '/eliminate-soldiers', { method: 'POST' }).then(function () { window.location.reload(); });
              return;
            }
          }
          window.location.reload();
        });
    }
  });

  deadList.addEventListener('click', function (e) {
    var reviveBtn = e.target.closest('.revive-btn');
    if (!reviveBtn) return;
    var li = e.target.closest('li');
    var playerId = li.getAttribute('data-player-id');
    fetch(base + '/players/' + playerId + '/revive', { method: 'POST' })
      .then(function () { window.location.reload(); });
  });
})();

// --- Page perso du Herault : minuteur 30 min -----------------------------
(function () {
  var el = document.getElementById('herald-timer');
  if (!el || typeof window.HERALD_LAST_SIGNAL === 'undefined') return;

  var lastSignal = new Date(window.HERALD_LAST_SIGNAL).getTime();
  var durationMs = window.HERALD_MINUTES * 60 * 1000;

  function tick() {
    var remaining = lastSignal + durationMs - Date.now();
    if (remaining <= 0) {
      el.textContent = 'Rappel !';
      el.classList.add('alert');
      return;
    }
    var totalSeconds = Math.floor(remaining / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    el.textContent = minutes + ':' + String(seconds).padStart(2, '0');
    el.classList.remove('alert');
  }

  tick();
  setInterval(tick, 1000);
})();
