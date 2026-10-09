/**
 * server/db.js — Database SQLite del server (modulo node:sqlite, incluso in Node).
 *
 * Tabelle:
 *  - hotels    strutture clienti
 *  - users     amministratori, manager e dipendenti (ruolo + permessi)
 *  - sessions  accessi attivi (si salva solo l'impronta del token)
 *  - records   tutti i dati sincronizzati dell'app, uno per riga, come JSON:
 *              (hotel, archivio, id) → dati. "seq" cresce a ogni scrittura e
 *              permette ai dispositivi di scaricare solo le novità.
 *  - attempts  tentativi di accesso falliti (blocco temporaneo anti-forza bruta)
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS hotels (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  hotel_id TEXT REFERENCES hotels(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  pass_hash TEXT,
  pin_hash TEXT,
  perms TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_hotel ON users(hotel_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS records (
  hotel_id TEXT NOT NULL REFERENCES hotels(id),
  store TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  device TEXT,
  seq INTEGER NOT NULL,
  PRIMARY KEY (hotel_id, store, id)
);
CREATE INDEX IF NOT EXISTS records_seq ON records(hotel_id, seq);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counters (name, value) VALUES ('seq', 0);

CREATE TABLE IF NOT EXISTS attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  locked_until INTEGER NOT NULL
);
`;

/** Apre (o crea) il database nella cartella indicata. */
export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'stella.db'));
  db.exec(SCHEMA);
  return db;
}

/** Esegue fn dentro una transazione: o tutto o niente. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Prossimo numero di sequenza (da chiamare dentro una transazione). */
export function nextSeq(db) {
  db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'seq'").run();
  return db.prepare("SELECT value FROM counters WHERE name = 'seq'").get().value;
}

/** Copia coerente del database (anche mentre è in uso). */
export function backup(db, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}
