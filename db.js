const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS parties (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    admin_token TEXT NOT NULL UNIQUE,
    expected_players INTEGER NOT NULL,
    deck_json TEXT NOT NULL,
    next_index INTEGER NOT NULL DEFAULT 0,
    herald_signal_minutes INTEGER NOT NULL DEFAULT 30,
    last_signal_at TEXT
  );

  CREATE TABLE IF NOT EXISTS boxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id TEXT NOT NULL,
    number TEXT NOT NULL,
    role_id TEXT NOT NULL,
    UNIQUE(party_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    alive INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    joined_at TEXT NOT NULL,
    eliminated_at TEXT,
    fee_protected INTEGER NOT NULL DEFAULT 0,
    death_cause TEXT,
    UNIQUE(party_id, name)
  );

  CREATE TABLE IF NOT EXISTS reveals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id TEXT NOT NULL,
    viewer_player_id INTEGER NOT NULL,
    target_player_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Migration douce pour une base existante creee avant l'ajout de ces colonnes.
const existingColumns = db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
if (!existingColumns.includes('fee_protected')) {
  db.exec('ALTER TABLE players ADD COLUMN fee_protected INTEGER NOT NULL DEFAULT 0');
}
if (!existingColumns.includes('death_cause')) {
  db.exec('ALTER TABLE players ADD COLUMN death_cause TEXT');
}

module.exports = db;
