// Transports : comment un telephone parle a la partie.
//  - local : la partie vit dans ce telephone (localStorage), comme avant. Site statique / hors-ligne.
//  - ws    : la partie vit sur le serveur de l'hote (PC), les telephones s'y connectent par WebSocket.
// Interface commune : start({ onState(view), onStatus(status) }), dispatch(action, cb(result)), now().
(function () {
  'use strict';

  var GAME_KEY = 'vf-partie-v1';

  function localTransport(game) {
    var G = null;
    var h = {};

    function load() {
      try {
        var raw = localStorage.getItem(GAME_KEY);
        return game.normalize(raw ? JSON.parse(raw) : null);
      } catch (e) {
        return game.normalize(null);
      }
    }
    function save() {
      try {
        var o = {};
        game.SHARED_KEYS.forEach(function (k) { o[k] = G[k]; });
        localStorage.setItem(GAME_KEY, JSON.stringify(o));
      } catch (e) { /* ignore */ }
    }
    function copy() { return JSON.parse(JSON.stringify(game.view(G))); }

    return {
      kind: 'local',
      start: function (handlers) {
        h = handlers;
        G = load();
        h.onStatus('online');
        h.onState(copy());
        // Morts en attente d'annonce (pouvoirs) : l'heure vient toute seule.
        setInterval(function () {
          if (game.tick(G)) { save(); h.onState(copy()); }
        }, 1000);
      },
      dispatch: function (action, cb) {
        var result = game.apply(G, action);
        save();
        h.onState(copy());
        if (cb) cb(result);
      },
      now: function () { return Date.now(); }
    };
  }

  function wsTransport() {
    var ws = null;
    var h = {};
    var nextId = 1;
    var pending = {};
    var offset = 0;
    var tries = 0;
    var timer = null;

    function url() {
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }

    function failPending() {
      var p = pending;
      pending = {};
      Object.keys(p).forEach(function (id) { p[id]({ err: 'offline' }); });
    }

    function connect() {
      clearTimeout(timer);
      h.onStatus('connecting');
      var sock;
      try { sock = new WebSocket(url()); } catch (e) { retry(); return; }
      ws = sock;
      sock.onopen = function () { tries = 0; h.onStatus('online'); };
      sock.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.t === 'state') {
          offset = msg.now - Date.now();
          h.onState(msg.state);
        } else if (msg.t === 'res') {
          var cb = pending[msg.id];
          delete pending[msg.id];
          if (cb) cb(msg.result);
        }
      };
      sock.onclose = function () {
        if (ws !== sock) return;
        ws = null;
        h.onStatus('offline');
        failPending();
        retry();
      };
      sock.onerror = function () { /* onclose suit */ };
    }

    function retry() {
      tries += 1;
      timer = setTimeout(connect, Math.min(4000, 400 * tries));
    }

    // Au reveil du telephone : reconnecte tout de suite, ou redemande l'etat courant.
    function wake() {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'sync' }));
      else if (!ws || ws.readyState > 1) connect();
    }

    return {
      kind: 'ws',
      start: function (handlers) {
        h = handlers;
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('online', wake);
        connect();
      },
      dispatch: function (action, cb) {
        if (!ws || ws.readyState !== 1) { if (cb) cb({ err: 'offline' }); return; }
        var id = nextId++;
        pending[id] = cb || function () {};
        ws.send(JSON.stringify({ t: 'act', id: id, action: action }));
      },
      now: function () { return Date.now() + offset; }
    };
  }

  window.VFNet = { local: localTransport, ws: wsTransport };
})();
