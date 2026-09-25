# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A French-language hidden-role party game ("loup-garou"-style) meant to run alongside a real house party over several hours. **One shared phone** is passed around to draw roles, then sits in the middle of the room as the "Village" screen; each player briefly opens a private "espace secret" to see their role and use their power. The host's laptop runs the server on the local network and phones connect over wifi — **there is no guaranteed internet at the venue**, which is why fonts are self-hosted (see below).

There used to be a second, multi-device implementation (per-player links, admin dashboard, SQLite). It was deleted on purpose; this single-phone client-only version is now the only one. Don't reintroduce a database or per-player URLs.

**`master` is the web-only version**: the PC runs `server.js` and a single phone opens the page over the local wifi. The Android/Capacitor app, PWA files, Play Store visuals and privacy policy live only on the **`appli-mobile`** branch (a revert of that work sits on `master`; re-merging it means reverting the revert). `.gitignore` on `master` blocks `android/`, `www/` and signing keys so they can never be committed here.

## Commands

```bash
npm install       # express, ejs — nothing else, no native build step
npm start         # or: node server.js — serves on :3000
```

On Windows PowerShell, if `npm start` fails with an execution-policy error, use `npm.cmd start` (or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once).

There is no test suite, linter, or build step. Check syntax with `node --check public/jeu.js`. No browser is available to Claude Code here, so UI changes have only been verified by running `jeu.js` in a `vm` context against a stubbed `document` (fake `getElementById`/`localStorage`, capture the `click` listener registered on `#app`, then call it with `{ target: { closest: () => ({ getAttribute: k => ... }) } }`) — that pattern works well for exercising whole flows. Visual fidelity has to be checked by the user on a phone.

The phones need the host's LAN IP (`Get-NetIPAddress -AddressFamily IPv4` in PowerShell); it changes when the wifi reconnects, so re-check it if devices can't connect.

## Static site (GitHub Pages)

`npm run build:site` (`scripts/build-site.js`) renders `views/jeu.ejs` with `page.js` data into **`docs/`** (committed, generated — never edit by hand) so the game can be served by GitHub Pages (Settings > Pages > branch `master`, folder `/docs`) at a stable URL, e.g. `https://neonix13.github.io/Village-Fantaisie/`. Asset URLs in `jeu.ejs`/`jeu.css` are deliberately **relative** (no leading `/`) so the site works under a sub-path. Re-run the build and commit `docs/` after every change to `public/`, `views/` or `roles.js`, otherwise the hosted copy goes stale. Pages needs HTTPS internet at first load; there is no service worker on `master` (it exists only on `appli-mobile`).

## Architecture

- **`server.js`** only serves `GET /` (rendering `views/jeu.ejs`), redirects `/jeu` → `/`, and statics from `public/`. It pre-renders every role badge once at startup and injects `window.VF_ROLES`, `window.VF_PRIORITY`, `window.VF_BADGES` into the page.
- **`roles.js`** is the single source of truth for the role catalog (`ROLES`: camp, `known` for the public `***` roles, fixed `item`, `needsBox`, `special`, French description) and `PRIORITY` (the default pool of possible characters). Card copy is authored here with accents, matching the design handoff.
- **`views/partials/role_badge.ejs`** draws each role's SVG shield. Because the client has no template engine, `server.js` calls `ejs.render()` on it directly and ships the resulting strings; `badge(id, size, fill)` in `jeu.js` only injects width/height and a `--vf-badge-fill` CSS variable into the string.
- **`public/jeu.js`** is the whole game: a hand-rolled `innerHTML` render loop, no framework. State lives in `localStorage` (`vf-partie-v1`), saved on every change. On reload it deliberately downgrades `reveal`→`pioche`, `space`→`hub` and `deck`→`setup` for privacy. `render()` swaps `#vf-screen`; the bottom sheet (`#vf-sheet`) and the privacy curtain (`#vf-curtain`) live outside it so they survive re-renders and their animations don't restart. Screens: onboard → setup → (deck) → pioche → reveal → hub (Village / Espaces / Rôles tabs) → space → recap. Interactions are all `data-action`/`data-arg` attributes handled by one delegated `onClick` switch.
- **`public/jeu.css`** holds all styling (gold/tarot theme, design tokens as `--vf-*`, keyframes `vf*`). Most screen-specific layout is inline style strings inside `jeu.js`, copied from the design handoff.

### Game rules implemented in `jeu.js`

- **Deck = a pool, not a fixed list.** `state.custom` is a `{roleId: count}` pool of *possible* characters (default `countsOf(PRIORITY)`); it may exceed the player count. `drawFromPool(pool, n)` shuffles it, takes `n` cards, pads with Villageois if the pool is short, then repairs dependencies (Soldat needs Roi, Diable needs Démon) by swapping a card. Nobody knows the exact composition — the Rôles tab therefore lists possible roles without quantities. Keep it that way.
- **Box numbers**: the role's `needsBox` items live in a numbered box. Number is manual per role (`state.boxes[roleId]`, set on the "Boîtes" tab of the deck screen) or, if empty, the holder's rank among players whose role has `needsBox`.
- **Manche (round)**: ends when the Hérault rings the horn (timer reset) or a player is declared "gracié(e)". Both restart the 30-min timer, clear the Fée's protection (`state.fee`) and re-enable the Vampire's bite (`state.conv`). A death by "Pendu" does *not* end the round.
- **Eliminations** go through a cause picker (Dévoré/Brûlé/Asphyxié/Pendu/Empoisonné); a Fée-protected player survives once instead. Killing the Roi offers to ban all living Soldats (cause `bannissement`).
- **Vampire** converts one living player per round (not the Licorne) into `rejeton_vampire`, who discovers it via a banner in their space; converting a Fée clears `state.fee`.
- Roles with `special`: Prêtre (2 private consultations), Fée, Espion (6-guess notebook; 6 correct at the end wins alone), Diable (sees all roles), Hérault (timer). Not modelled: the Diable dying when the Démons die, the Succube's mechanics, the Licorne's revenge — these are table-talk, not app logic.

## Gotchas

- **Fonts are self-hosted** (`public/fonts/material-symbols-rounded{,-fill}.woff2`, static instances, outline + filled), not loaded from Google Fonts — deliberate, for the offline constraint. Icon names must exist in that font. If re-fetching, get the woff2 URLs from `fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0` (and `…,1,0` for the filled one) with a Chrome user-agent.
- **EJS tokenizer trap**: `role_badge.ejs` once had a literal `<%- include(...) %>` example inside a JS comment inside a `<% %>` block, which produces `Could not find matching close tag for "<%"` with no line number, because EJS scans raw text for `<%`/`%>` without understanding JS comments. Never write tag-shaped text in a comment inside a scriptlet.
- Design source of truth: the handoff `Mobile app design planning.zip` (gitignored, kept outside version control; README + `.dc.html` source + a standalone `prototype-jouable.html`). Its README lists exact copy, sizes and timings per screen; the deck-customization, cause-of-death, manual-box, Vampire, Soldat-ban and "gracié(e)" features were added afterwards and are *not* in it.
- `data.sqlite*` files may still exist on disk from the deleted multi-device version; they are unused and gitignored. Don't delete them without asking — they hold old party data.
- Multi-line shell heredocs of ~30KB+ fail (`ENAMETOOLONG`); write large patches to a scratch file with the Write tool and apply them with a small node script.
