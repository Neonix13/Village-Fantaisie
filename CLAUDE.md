# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A French-language hidden-role party game ("loup-garou"-style) meant to run alongside a real house party over several hours. **One shared phone** is passed around to draw roles, then sits in the middle of the room as the "Village" screen; each player briefly opens a private "espace secret" to see their role and use their power. The host's laptop runs the server on the local network and phones connect over wifi — **there is no guaranteed internet at the venue**, which is why fonts are self-hosted (see below).

There used to be a second, multi-device implementation (per-player links, admin dashboard, SQLite). It was deleted on purpose; this single-phone client-only version is now the only one. Don't reintroduce a database or per-player URLs.

## Commands

```bash
npm install       # express, ejs — nothing else, no native build step
npm start         # or: node server.js — serves on :3000
```

On Windows PowerShell, if `npm start` fails with an execution-policy error, use `npm.cmd start` (or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once).

There is no test suite, linter, or build step. Check syntax with `node --check public/jeu.js`. No browser is available to Claude Code here, so UI changes have only been verified by running `jeu.js` in a `vm` context against a stubbed `document` (fake `getElementById`/`localStorage`, capture the `click` listener registered on `#app`, then call it with `{ target: { closest: () => ({ getAttribute: k => ... }) } }`) — that pattern works well for exercising whole flows. Visual fidelity has to be checked by the user on a phone.

The phones need the host's LAN IP (`Get-NetIPAddress -AddressFamily IPv4` in PowerShell); it changes when the wifi reconnects, so re-check it if devices can't connect.

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

## Mobile app (branch `appli-mobile`)

The goal on this branch is shipping the same game as a real app (Android APK / Play Store, then iPhone). Approach: **the web app is packaged, not rewritten** — Capacitor wraps a static build.

- `npm run build` (`scripts/build.js`) renders `views/jeu.ejs` with the data from `page.js` and copies `public/` into **`www/`** (gitignored): a fully static, serverless copy of the app. `page.js` is shared by `server.js` (dev) and the build, so role data/badges have one code path.
- `capacitor.config.json` (`appId` **`com.neonix13.villagefantaisy` is a placeholder** — it becomes permanent once published, confirm it with the user before any store submission) points `webDir` at `www`. `npm run cap:sync` = build + copy into `android/`; `npm run android:open` opens it in Android Studio.
- `android/` is the generated native project (committed, its own `.gitignore` handles build output). Portrait is locked in `AndroidManifest.xml`. Launcher icons and splash screens under `android/app/src/main/res/` come from `@capacitor/assets` (`npx capacitor-assets generate --android --iconBackgroundColor "#100e17" --splashBackgroundColor "#100e17"`), fed by `assets/` — regenerate the sources with `npm run icons` (`scripts/make-icons.js`, uses `sharp`, draws a gold diamond + the Roi crown).
- **This machine has no Java / Android SDK**, so the APK has not been compiled here; only `cap add android` and `cap sync` were run. Building needs Android Studio. **iOS is not added yet**: `npx cap add ios` (then Xcode + an Apple Developer account) must be done on a Mac.
- **Building on this machine** works from the CLI using Android Studio's bundled JDK and SDK: `JAVA_HOME="C:/Program Files/Android/Android Studio/jbr"`, `ANDROID_HOME=$LOCALAPPDATA/Android/Sdk`, then `cd android && ./gradlew.bat assembleDebug --no-daemon` (test APK) or `bundleRelease` (Play Store bundle). `android/local.properties` (`sdk.dir=…`) is gitignored and machine-specific.
- **Release signing is done AFTER Gradle with `jarsigner`, not in `build.gradle`**: the bundled JDK is 25, and Gradle 8.14 crashes ("Unsupported class file major version 69") as soon as `app/build.gradle` uses Java classes such as `Properties`/`FileInputStream`. So: `bundleRelease` → `jarsigner -keystore android/upload-keystore.jks -sigalg SHA256withRSA -digestalg SHA-256 -signedjar out.aab app-release.aab upload`. The upload key and its password (`android/upload-keystore.jks`, `android/keystore.properties`) are gitignored and were also copied to the user's Desktop for backup; **losing them means no more updates** — never commit or regenerate them. Bump `versionCode` in `android/app/build.gradle` for every upload.
- `docs/confidentialite.html` is the privacy policy required by the Play Store (the app collects nothing); it is meant to be served by GitHub Pages from `/docs` (the `.gitignore` re-allows `docs/*.html`).
- PWA bits (`public/manifest.webmanifest`, `public/sw.js`, tags in `jeu.ejs`) work only over HTTPS/localhost — on the LAN over plain `http://` the service worker silently doesn't register. `sw.js` is not registered inside the Capacitor shell (`window.Capacitor` guard). Bump `VERSION` in `sw.js` when shipping cache-affecting changes.
- Absolute asset paths (`/jeu.js`, `/fonts/…`) are intentional: Capacitor serves `www/` from an `https://localhost` origin, so they resolve; `file://` would break them.
- Passing an app name containing `&` to `npx.cmd` breaks under Windows cmd — edit `capacitor.config.json` directly instead of using `cap init`.

## Gotchas

- **Fonts are self-hosted** (`public/fonts/material-symbols-rounded{,-fill}.woff2`, static instances, outline + filled), not loaded from Google Fonts — deliberate, for the offline constraint. Icon names must exist in that font. If re-fetching, get the woff2 URLs from `fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0` (and `…,1,0` for the filled one) with a Chrome user-agent.
- **EJS tokenizer trap**: `role_badge.ejs` once had a literal `<%- include(...) %>` example inside a JS comment inside a `<% %>` block, which produces `Could not find matching close tag for "<%"` with no line number, because EJS scans raw text for `<%`/`%>` without understanding JS comments. Never write tag-shaped text in a comment inside a scriptlet.
- Design source of truth: the handoff `Mobile app design planning.zip` (gitignored, kept outside version control; README + `.dc.html` source + a standalone `prototype-jouable.html`). Its README lists exact copy, sizes and timings per screen; the deck-customization, cause-of-death, manual-box, Vampire, Soldat-ban and "gracié(e)" features were added afterwards and are *not* in it.
- `data.sqlite*` files may still exist on disk from the deleted multi-device version; they are unused and gitignored. Don't delete them without asking — they hold old party data.
- Multi-line shell heredocs of ~30KB+ fail (`ENAMETOOLONG`); write large patches to a scratch file with the Write tool and apply them with a small node script.
