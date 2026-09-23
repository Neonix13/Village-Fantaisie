# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A French-language party game app: a hidden-role game ("loup-garou"-style) meant to run alongside a real house party over several hours, on a local network with no guaranteed internet access (the host's laptop runs the server, guests connect over wifi from their phones). This constraint (offline-capable) matters for any dependency decisions — see the `/jeu` section below.

## Commands

```bash
npm install       # express, ejs — no native build step (see Database below)
npm start          # or: node server.js — starts on :3000
```

On Windows PowerShell, if `npm start` fails with an execution-policy error, use `npm.cmd start` instead (or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, permanently).

There is no test suite, linter, or build step. Verify changes by starting the server and exercising routes with `curl`, or an offline `ejs.render()` call for a quick syntax check on a single view (see "EJS gotcha" below for why this matters).

To find the LAN IP other devices should use: `Get-NetIPAddress -AddressFamily IPv4` (PowerShell) — the Wi-Fi adapter's address changes across reconnects, so re-check it if devices can't connect mid-party.

## Database

Uses Node's **built-in `node:sqlite`** (`DatabaseSync`), not `better-sqlite3` — a native module was tried first and failed to build on Windows (no Python/build tools), so this repo deliberately avoids any native dependency. Requires Node ≥22.5. The API surface used (`db.prepare(sql).run/get/all(...params)`) is close enough to `better-sqlite3` that this matters if you're ever tempted to "fix" an import.

`db.js` creates the schema with `CREATE TABLE IF NOT EXISTS` and then does ad-hoc `ALTER TABLE ... ADD COLUMN` migrations guarded by a `PRAGMA table_info` check, run on every startup. There's no migration framework — follow that same pattern (check-then-`ALTER`) if you add a column, so the currently-live `data.sqlite` isn't destroyed on the next server restart. **Never delete or reset `data.sqlite` without checking with the user first** — it holds real party data (player names, live game state) that may be mid-session.

Tables: `parties` (one row per game, holds the shuffled `deck_json` array and a `next_index` cursor into it), `players` (one row per drawn role, keyed by a random `token` used for that player's private URL), `boxes` (MJ-assigned physical box numbers for roles that have real-world items), `reveals` (Prêtre's consultation log, capped at 2 per player in application code).

## Two coexisting systems

This repo currently contains **two parallel implementations of the same game**, at different stages of completion. Check which one a task concerns before editing.

### 1. Legacy multi-device system (`/admin/...`, `/pioche/...`, `/moi/...`, `/plateau/...`) — complete, in active use

Server-rendered (Express + EJS), server-authoritative state in SQLite. Each player gets their own private URL (`/moi/:token`) bookmarked from the shared draw screen; the party organizer uses an admin-token-gated hub (`/admin/:partyId/:adminToken`).

- **`roles.js`** is the single source of truth for the role catalog (`ROLES`), the auto-balancing priority order (`PRIORITY`), and deck-building (`buildDeck`, `buildCustomDeck`, `shuffle`). Both this system and `/jeu` below read from it — never duplicate role text/logic elsewhere without a comment pointing back here.
- **Party creation is a 4-step wizard**: player count (`/admin/new`) → deck composition (`/admin/:id/:token/deck`, "simplifié" mode with steppers/checkboxes vs "détaillé" mode with exact per-role counts — see `buildCustomDeck` for the guarantee/random-fill/dependency-completion algorithm) → box assignment (`/admin/:id/:token/boxes-step`, skipped automatically if no role in the deck has `needsBox`) → the shared draw screen (`/pioche/:partyId`).
- **Deck dependency rules** live in `buildCustomDeck` (roles.js): if `soldat` is in the deck, `roi` is force-added; if `diable` is in the deck, `demon` is force-added. `PAIR_ROLES` (`soldat`, `demon`) only controls whether the "simplifié" UI shows a +/- stepper (arbitrary count) vs a checkbox (0 or 1) — it does **not** mean these roles are always dealt in pairs; that assumption was wrong once already and was corrected.
- **The admin dashboard deliberately shows no role information** — it's used by whoever is running votes during the party (not necessarily the person who set up the game), so it only exposes two actions: "Pouvoir" (look yourself up by name to reach your own `/moi/:token`) and "Liste des joueurs" (alive/dead names only, with a 5-cause elimination picker: `devore`/`brule`/`asphyxie`/`pendu`/`empoisonne`, plus an internal-only `bannissement` cause used when the King's death auto-eliminates both Soldats).
- **Special-role mechanics live in `/moi/:token` handlers**, keyed off `role.special` in `roles.js` (`priest_reveal`, `devil_omniscient`, `fee_protect`, `spy_notes`): Prêtre reveals, Diable's omniscient roster, Fée's protection (auto-blocks the next elimination attempt server-side, cleared when the Hérault resets the 30-min timer), Espion's private notes, Hérault's countdown.
- Not implemented anywhere in this system: Rejeton Vampire conversion (the role exists in the catalog with `notDealt: true` — it's a mid-game conversion state, never drawn from the deck).

### 2. New "un seul téléphone" mode (`/jeu`) — in progress, being built screen-by-screen

A from-scratch client-only rewrite driven by a design handoff (see below), meant to **eventually replace** the legacy system entirely — but only once fully built and validated; don't remove the legacy system preemptively.

- Single shared device, no server round-trips during play: all state lives in `localStorage` (key `vf-partie-v1`) inside `public/jeu.js`, a hand-rolled `innerHTML`-based render loop (no framework). `views/jeu.ejs` is a near-empty shell whose only job is to serialize server-side data into `window.VF_ROLES` / `window.VF_PRIORITY` / `window.VF_BADGES` for the client script to consume.
- **Role badges** (`views/partials/role_badge.ejs`, SVG shields, camp-colored via CSS classes) are pre-rendered **server-side once per request** in the `GET /jeu` handler (via `ejs.render()` called directly, not `res.render()`) and shipped to the client as ready-made SVG strings, because the client has no template engine of its own. See `renderRoleBadge()` in `server.js`.
- **Deck-building logic is duplicated** client-side in `jeu.js` (`buildDeck`/`shuffleArr`) as a deliberate, commented port of `roles.js`'s plain "automatique" algorithm — this mode does not use the "détaillé"/"simplifié" custom modes or the MJ box editor from the legacy system (box number is derived automatically: rank among players whose role has `needsBox`).
- **Fonts are self-hosted** (`public/fonts/material-symbols-rounded{,-fill}.woff2`), not loaded from Google Fonts — this was a deliberate call given the no-internet-at-the-venue constraint. If more icon glyphs are needed later, re-fetch from `fonts.googleapis.com/css2?family=Material+Symbols+Rounded:...` (see git history for the exact curl invocation) rather than switching to a CDN `<link>`.
- The design spec this mode is being built from — exact colors/sizes/copy/animation timings for every screen, the full client-state schema, and an explicit list of what's intentionally *not* covered (Rejeton Vampire conversion, Soldat banishment-on-King's-death cascade) — lives outside this repo in `Mobile app design planning.zip` (extracted README + `.dc.html` source + a standalone `prototype-jouable.html` you can open directly in a browser to see the target behavior). Re-extract it if needed; treat its README as the spec of record for screens not yet built rather than re-deriving values from scratch.
- Only the onboarding screen (`renderOnboard` in `jeu.js`) is built so far. Build remaining screens one at a time (setup → pioche → reveal → hub → secret space → recap, per the design README) and get them validated before moving on — that pacing was explicitly requested, not just a suggestion.

### EJS gotcha worth knowing about

`views/partials/role_badge.ejs` previously had a `// Usage: <%- include(...) %>` example inside a JS comment *inside* a `<% %>` scriptlet block. EJS's tokenizer scans the raw template text for `<%`/`%>` without any awareness of JS comment syntax, so a literal tag-shaped example inside a comment reliably breaks parsing with a confusing `Could not find matching close tag for "<%"` error that gives no line number. If you hit that error, grep the `.ejs` file for a stray `<%`/`%>` inside documentation text (not just count occurrences — they can be paired and still be the bug) rather than assuming the file is well-formed.

## Static files served directly

`public/` is served at the root via `express.static` — `style.css`/`app.js` belong to the legacy system, `jeu.css`/`jeu.js`/`fonts/` belong to `/jeu`. Keep them separate; don't merge them until the legacy system is actually being retired (see above).
