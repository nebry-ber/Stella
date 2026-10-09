/**
 * server/auth.js — Password, PIN, sessioni e blocco dei tentativi.
 *
 * - Password e PIN sono salvati come impronta scrypt con sale casuale.
 * - Il token di sessione va al browser in un cookie HttpOnly; nel database
 *   resta solo la sua impronta SHA-256, così una copia del database non
 *   permette di entrare.
 * - Dopo 5 tentativi sbagliati l'accesso si blocca per 15 minuti.
 */

import crypto from 'node:crypto';
import { tx } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const SESSION_DAYS = 60;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export const PERMISSIONS = {
  closeAccounts: 'Chiudere i conti',
  editPrices: 'Modificare listino e prezzi',
  editRooms: 'Modificare camere e postazioni',
  editSettings: 'Modificare dati struttura e tariffe di soggiorno',
};
/** Permessi predefiniti di un nuovo dipendente. */
export const DEFAULT_STAFF_PERMS = { closeAccounts: true, editPrices: false, editRooms: false, editSettings: false };

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifySecret(secret, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(secret), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const newId = () => crypto.randomUUID();

/** Password robusta e leggibile, es. "kite-Mora-7342-vela". */
export function generatePassword() {
  const words = ['neve', 'baita', 'malga', 'larice', 'cervo', 'vetta', 'prato', 'lago', 'sole', 'pino', 'rifugio', 'stella', 'camoscio', 'ruscello'];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 9999)}-${pick()}`;
}

// ---------------------------------------------------------------------------
// Sessioni
// ---------------------------------------------------------------------------

export function createSession(db, userId, userAgent = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, now, now + SESSION_DAYS * 864e5, now, String(userAgent).slice(0, 200));
  return token;
}

/** Utente della sessione (o null). Rinnova la scadenza a ogni uso. */
export function sessionUser(db, token) {
  if (!token) return null;
  const now = Date.now();
  const row = db.prepare(`
    SELECT s.token_hash, s.expires_at, u.*, h.code AS hotel_code, h.name AS hotel_name, h.active AS hotel_active
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN hotels h ON h.id = u.hotel_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < now || !row.active || (row.hotel_id && !row.hotel_active)) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  // Rinnovo "scorrevole", al massimo una volta all'ora per non scrivere a ogni richiesta
  if (now - (row.expires_at - SESSION_DAYS * 864e5) > 3600e3) {
    db.prepare('UPDATE sessions SET expires_at = ?, last_seen = ? WHERE token_hash = ?').run(now + SESSION_DAYS * 864e5, now, row.token_hash);
  }
  return publicUser(row);
}

export function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function deleteUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Dati dell'utente sicuri da mandare al browser. */
export function publicUser(row) {
  const perms = row.role === 'staff'
    ? { ...DEFAULT_STAFF_PERMS, ...JSON.parse(row.perms || '{}') }
    : Object.fromEntries(Object.keys(PERMISSIONS).map((k) => [k, true]));
  return {
    id: row.id, name: row.name, role: row.role, email: row.email || null, perms,
    hotel: row.hotel_id ? { id: row.hotel_id, code: row.hotel_code, name: row.hotel_name } : null,
  };
}

// ---------------------------------------------------------------------------
// Blocco dei tentativi sbagliati
// ---------------------------------------------------------------------------

/** Millisecondi di blocco residui per questa chiave (0 = libero). */
export function lockedFor(db, key) {
  const row = db.prepare('SELECT locked_until FROM attempts WHERE key = ?').get(key);
  return row ? Math.max(0, row.locked_until - Date.now()) : 0;
}

export function registerFailure(db, key, max = MAX_FAILS) {
  tx(db, () => {
    const row = db.prepare('SELECT fails FROM attempts WHERE key = ?').get(key);
    const fails = (row?.fails || 0) + 1;
    const locked = fails >= max ? Date.now() + LOCK_MS : 0;
    db.prepare('INSERT INTO attempts (key, fails, locked_until) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until')
      .run(key, locked ? 0 : fails, locked);
  });
}

export function clearFailures(db, key) {
  db.prepare('DELETE FROM attempts WHERE key = ?').run(key);
}
