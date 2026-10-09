/**
 * server/index.js — Server HTTP: serve l'app (file statici) e le API.
 *
 * Avvio:  node server/index.js
 * Variabili d'ambiente:
 *   PORT           porta (predefinita 3000)
 *   DATA_DIR       cartella del database (predefinita ./data)
 *   COOKIE_SECURE  "1" in produzione (HTTPS): cookie solo su connessioni cifrate
 *   TRUST_PROXY    "1" dietro Caddy: legge l'IP reale da X-Forwarded-For
 *
 * API (JSON):
 *   GET  /api/health                stato del server
 *   POST /api/login                 accesso manager/amministratore (email + password)
 *   GET  /api/hotel/:code/staff     nomi dei dipendenti per la schermata di accesso
 *   POST /api/login-pin             accesso dipendente (codice struttura + nome + PIN)
 *   POST /api/logout
 *   GET  /api/me                    utente collegato
 *   POST /api/sync                  invia le modifiche e riceve quelle degli altri
 *   POST /api/password              cambio password (manager/amministratore)
 *   GET  /api/staff                 dipendenti della struttura (manager)
 *   POST /api/staff                 nuovo dipendente (manager)
 *   PATCH /api/staff/:id            modifica nome, PIN, permessi, attivo (manager)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import * as A from './auth.js';
import { applyChanges, pullChanges, MAX_RECORDS_PER_PUSH } from './sync.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '1';
const COOKIE = 'sa_session';
const MAX_BODY = 8 * 1024 * 1024;
const DUMMY_HASH = A.hashSecret('nessun-utente');

// ---------------------------------------------------------------------------
// Utilità HTTP
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Richiesta troppo grande.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON non valido.')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, opts) {
  const attrs = [`${COOKIE}=${token || ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? A.SESSION_DAYS * 86400 : 0}`];
  if (opts.cookieSecure) attrs.push('Secure');
  return attrs.join('; ');
}

function clientIp(req, opts) {
  if (opts.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

// ---------------------------------------------------------------------------
// File statici dell'app (solo quelli pubblici)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
const PUBLIC_FILES = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);
const PUBLIC_DIRS = ['/css/', '/js/', '/icons/'];
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return false; }
  if (p === '/') p = '/index.html';
  const allowed = PUBLIC_FILES.has(p) || PUBLIC_DIRS.some((d) => p.startsWith(d));
  const file = path.join(ROOT, p);
  if (!allowed || !file.startsWith(ROOT + path.sep) || p.includes('..')) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// Rotte API
// ---------------------------------------------------------------------------

function requireUser(ctx, ...roles) {
  if (!ctx.user) throw new HttpError(401, 'Accesso richiesto.');
  if (roles.length && !roles.includes(ctx.user.role)) throw new HttpError(403, 'Operazione non consentita.');
  if (!ctx.user.hotel && ctx.user.role !== 'admin') throw new HttpError(403, 'Utente senza struttura.');
  return ctx.user;
}

function checkLock(db, keys) {
  const ms = Math.max(...keys.map((k) => A.lockedFor(db, k)));
  if (ms > 0) throw new HttpError(429, `Troppi tentativi. Riprova tra ${Math.ceil(ms / 60000)} minuti.`);
}

const staffRow = (r) => ({ id: r.id, name: r.name, active: !!r.active, perms: { ...A.DEFAULT_STAFF_PERMS, ...JSON.parse(r.perms || '{}') } });

function cleanPerms(input) {
  const out = {};
  for (const k of Object.keys(A.PERMISSIONS)) out[k] = !!input?.[k];
  return out;
}

const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, version: VERSION, time: Date.now() })],

  ['POST', /^\/api\/login$/, async ({ db, req, res, opts, body }) => {
    const email = str(body.email, 200).toLowerCase();
    const ip = clientIp(req, opts);
    checkLock(db, [`pwd:${email}`, `ip:${ip}`]);
    const row = db.prepare("SELECT * FROM users WHERE email = ? AND role IN ('manager', 'admin') AND active = 1").get(email);
    // Stesso tempo di risposta anche se l'email non esiste (non si scopre chi è registrato)
    const ok = A.verifySecret(String(body.password || ''), row?.pass_hash || DUMMY_HASH);
    if (!row || !ok) {
      A.registerFailure(db, `pwd:${email}`);
      A.registerFailure(db, `ip:${ip}`, 30);
      throw new HttpError(401, 'Email o password non corretti.');
    }
    A.clearFailures(db, `pwd:${email}`);
    const token = A.createSession(db, row.id, req.headers['user-agent']);
    res.setHeader('Set-Cookie', sessionCookie(token, opts));
    return { user: A.sessionUser(db, token) };
  }],

  ['GET', /^\/api\/hotel\/([a-z0-9-]{2,40})\/staff$/, ({ db, params }) => {
    const hotel = db.prepare('SELECT id, name FROM hotels WHERE code = ? AND active = 1').get(params[0]);
    if (!hotel) throw new HttpError(404, 'Codice struttura non trovato.');
    const staff = db.prepare("SELECT id, name FROM users WHERE hotel_id = ? AND role = 'staff' AND active = 1 ORDER BY name COLLATE NOCASE").all(hotel.id);
    return { hotel: { name: hotel.name }, staff };
  }],

  ['POST', /^\/api\/login-pin$/, async ({ db, req, res, opts, body }) => {
    const userId = str(body.userId, 80);
    const ip = clientIp(req, opts);
    checkLock(db, [`pin:${userId}`, `ip:${ip}`]);
    const row = db.prepare(`SELECT u.* FROM users u JOIN hotels h ON h.id = u.hotel_id
      WHERE u.id = ? AND h.code = ? AND u.role = 'staff' AND u.active = 1 AND h.active = 1`).get(userId, str(body.code, 40));
    if (!row || !A.verifySecret(String(body.pin || ''), row.pin_hash)) {
      if (row) A.registerFailure(db, `pin:${userId}`);
      A.registerFailure(db, `ip:${ip}`, 30);
      throw new HttpError(401, 'PIN non corretto.');
    }
    A.clearFailures(db, `pin:${userId}`);
    const token = A.createSession(db, row.id, req.headers['user-agent']);
    res.setHeader('Set-Cookie', sessionCookie(token, opts));
    return { user: A.sessionUser(db, token) };
  }],

  ['POST', /^\/api\/logout$/, ({ db, res, opts, token }) => {
    A.deleteSession(db, token);
    res.setHeader('Set-Cookie', sessionCookie('', opts));
    return { ok: true };
  }],

  ['GET', /^\/api\/me$/, (ctx) => ({ user: requireUser(ctx) })],

  ['POST', /^\/api\/sync$/, (ctx) => {
    const user = requireUser(ctx, 'manager', 'staff');
    const changes = ctx.body.changes || {};
    const count = Object.values(changes).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
    if (count > MAX_RECORDS_PER_PUSH) throw new HttpError(413, 'Troppe modifiche in una volta.');
    const pushed = applyChanges(ctx.db, user, changes);
    const pulled = pullChanges(ctx.db, user.hotel.id, ctx.body.cursor);
    for (const { store, rec } of pushed.back) (pulled.changes[store] ||= []).push(rec);
    return { cursor: pulled.cursor, more: pulled.more, changes: pulled.changes, rejected: pushed.rejected, written: pushed.written, user };
  }],

  ['POST', /^\/api\/password$/, (ctx) => {
    const user = requireUser(ctx, 'manager', 'admin');
    const row = ctx.db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
    if (!A.verifySecret(String(ctx.body.current || ''), row.pass_hash)) throw new HttpError(400, 'La password attuale non è corretta.');
    const next = String(ctx.body.next || '');
    if (next.length < 10) throw new HttpError(400, 'La nuova password deve avere almeno 10 caratteri.');
    ctx.db.prepare('UPDATE users SET pass_hash = ?, updated_at = ? WHERE id = ?').run(A.hashSecret(next), Date.now(), user.id);
    return { ok: true };
  }],

  ['GET', /^\/api\/staff$/, (ctx) => {
    const user = requireUser(ctx, 'manager');
    const rows = ctx.db.prepare("SELECT * FROM users WHERE hotel_id = ? AND role = 'staff' ORDER BY active DESC, name COLLATE NOCASE").all(user.hotel.id);
    return { staff: rows.map(staffRow), permissions: A.PERMISSIONS, code: user.hotel.code };
  }],

  ['POST', /^\/api\/staff$/, (ctx) => {
    const user = requireUser(ctx, 'manager');
    const name = str(ctx.body.name, 40);
    const pin = String(ctx.body.pin || '');
    if (!name) throw new HttpError(400, 'Inserisci il nome del dipendente.');
    if (!/^\d{4,6}$/.test(pin)) throw new HttpError(400, 'Il PIN deve avere da 4 a 6 cifre.');
    const dup = ctx.db.prepare("SELECT 1 FROM users WHERE hotel_id = ? AND role = 'staff' AND name = ? COLLATE NOCASE").get(user.hotel.id, name);
    if (dup) throw new HttpError(409, 'Esiste già un dipendente con questo nome.');
    const id = A.newId();
    const now = Date.now();
    ctx.db.prepare("INSERT INTO users (id, hotel_id, role, name, pin_hash, perms, active, created_at, updated_at) VALUES (?, ?, 'staff', ?, ?, ?, 1, ?, ?)")
      .run(id, user.hotel.id, name, A.hashSecret(pin), JSON.stringify(cleanPerms(ctx.body.perms ?? A.DEFAULT_STAFF_PERMS)), now, now);
    return { staff: staffRow(ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  }],

  ['PATCH', /^\/api\/staff\/([0-9a-f-]{36})$/, (ctx) => {
    const user = requireUser(ctx, 'manager');
    const row = ctx.db.prepare("SELECT * FROM users WHERE id = ? AND hotel_id = ? AND role = 'staff'").get(ctx.params[0], user.hotel.id);
    if (!row) throw new HttpError(404, 'Dipendente non trovato.');
    const b = ctx.body;
    let logout = false;
    const set = { name: row.name, pin_hash: row.pin_hash, perms: row.perms, active: row.active };
    if (b.name !== undefined) {
      set.name = str(b.name, 40);
      if (!set.name) throw new HttpError(400, 'Il nome non può essere vuoto.');
      const dup = ctx.db.prepare("SELECT 1 FROM users WHERE hotel_id = ? AND role = 'staff' AND name = ? COLLATE NOCASE AND id <> ?").get(user.hotel.id, set.name, row.id);
      if (dup) throw new HttpError(409, 'Esiste già un dipendente con questo nome.');
    }
    if (b.pin !== undefined) {
      if (!/^\d{4,6}$/.test(String(b.pin))) throw new HttpError(400, 'Il PIN deve avere da 4 a 6 cifre.');
      set.pin_hash = A.hashSecret(String(b.pin));
      logout = true;
    }
    if (b.perms !== undefined) set.perms = JSON.stringify(cleanPerms(b.perms));
    if (b.active !== undefined) { set.active = b.active ? 1 : 0; if (!b.active) logout = true; }
    ctx.db.prepare('UPDATE users SET name = ?, pin_hash = ?, perms = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(set.name, set.pin_hash, set.perms, set.active, Date.now(), row.id);
    if (logout) A.deleteUserSessions(ctx.db, row.id);
    return { staff: staffRow(ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(row.id)) };
  }],
];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer({ dataDir = process.env.DATA_DIR || path.join(ROOT, 'data'), cookieSecure = process.env.COOKIE_SECURE === '1', trustProxy = process.env.TRUST_PROXY === '1', db: givenDb } = {}) {
  const db = givenDb || openDb(dataDir);
  const opts = { cookieSecure, trustProxy };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        res.end('Non trovato');
        return;
      }
      const match = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!match) throw new HttpError(404, 'API non trovata.');
      // Protezione CSRF: le richieste che modificano dati devono essere JSON e venire dallo stesso sito
      if (req.method !== 'GET') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Usa JSON.');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origine non consentita.');
      }
      const token = cookies(req)[COOKIE];
      const ctx = {
        db, req, res, opts, token,
        user: A.sessionUser(db, token),
        params: url.pathname.match(match[1]).slice(1),
        body: req.method === 'GET' ? {} : await readJson(req),
      };
      const result = await match[2](ctx);
      send(res, 200, result);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message });
      else { console.error(e); send(res, 500, { error: 'Errore interno del server.' }); }
    }
  });
  server.db = db;
  return server;
}

// Avvio diretto: node server/index.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`Stella: server in ascolto sulla porta ${port}`));
}
