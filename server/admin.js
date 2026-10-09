/**
 * server/admin.js — API del pannello dell'amministratore (il gestore del servizio).
 *
 *   GET   /api/admin/hotels                  elenco strutture con abbonamento e manager
 *   GET   /api/admin/hotels/:id              dettaglio (con logo)
 *   POST  /api/admin/hotels                  nuova struttura + manager con password provvisoria
 *   PATCH /api/admin/hotels/:id              dati, contatti, abbonamento, attiva/disattiva
 *   POST  /api/admin/hotels/:id/logo         logo della struttura (compare sulle ricevute)
 *   POST  /api/admin/hotels/:id/managers     manager aggiuntivo (password provvisoria)
 *   POST  /api/admin/users/:id/reset         nuova password provvisoria per un manager
 *
 * Le password provvisorie vengono mostrate una sola volta e vanno cambiate
 * dal manager al primo accesso.
 */

import { tx, nextSeq } from './db.js';
import * as A from './auth.js';
import { defaultHotel, HOTEL_ID } from '../js/model.js';

const CODE_RE = /^[a-z0-9-]{2,40}$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGO_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO = 400_000;
const ADMIN_DEVICE = 'Amministratore';

/** Stato dell'abbonamento in base alla scadenza. */
export function subscriptionStatus(h, today = new Date().toISOString().slice(0, 10)) {
  if (!h.active) return 'disattivata';
  if (!h.sub_end) return 'senza-scadenza';
  if (h.sub_end < today) return 'scaduto';
  const days = (Date.parse(h.sub_end) - Date.parse(today)) / 864e5;
  return days <= 30 ? 'in-scadenza' : 'attivo';
}

function readConfig(db, hotelId) {
  const row = db.prepare("SELECT data FROM records WHERE hotel_id = ? AND store = 'config' AND id = ?").get(hotelId, HOTEL_ID);
  return row ? JSON.parse(row.data) : null;
}

/** Scrive i dati struttura sincronizzati (arrivano a tutti i dispositivi della struttura). */
function writeConfig(db, hotelId, patch) {
  const name = db.prepare('SELECT name FROM hotels WHERE id = ?').get(hotelId)?.name || '';
  const cur = readConfig(db, hotelId) || { ...defaultHotel(), name, place: '' };
  const rec = { ...cur, ...patch, id: HOTEL_ID, updatedAt: Math.max(Date.now(), (cur.updatedAt || 0) + 1), device: ADMIN_DEVICE };
  db.prepare(`INSERT INTO records (hotel_id, store, id, data, updated_at, device, seq) VALUES (?, 'config', ?, ?, ?, ?, ?)
    ON CONFLICT(hotel_id, store, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, device = excluded.device, seq = excluded.seq`)
    .run(hotelId, HOTEL_ID, JSON.stringify(rec), rec.updatedAt, ADMIN_DEVICE, nextSeq(db));
}

/** Crea struttura e primo manager in una transazione. Usata anche dal terminale (cli.js). */
export function createHotel(db, { name, code, managerName, managerEmail, password, fields = {} }) {
  const hotelId = A.newId();
  const now = Date.now();
  tx(db, () => {
    db.prepare(`INSERT INTO hotels (id, code, name, active, created_at, contact_name, contact_email, contact_phone, plan, price_cents, sub_start, sub_end, notes)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hotelId, code, name, now, fields.contactName || '', fields.contactEmail || '', fields.contactPhone || '',
        fields.plan || '', fields.priceCents || 0, fields.subStart || '', fields.subEnd || '', fields.notes || '');
    db.prepare("INSERT INTO users (id, hotel_id, role, name, email, pass_hash, perms, active, must_change, created_at, updated_at) VALUES (?, ?, 'manager', ?, ?, ?, '{}', 1, ?, ?, ?)")
      .run(A.newId(), hotelId, managerName, managerEmail, A.hashSecret(password), fields.mustChange === false ? 0 : 1, now, now);
    // Intestazione della ricevuta con il nome giusto fin dal primo giorno
    writeConfig(db, hotelId, { name, place: '' });
  });
  return hotelId;
}

export function adminRoutes({ HttpError, requireUser, str }) {
  const isAdmin = (ctx) => requireUser(ctx, 'admin');

  function getHotelRow(db, id) {
    const h = db.prepare('SELECT * FROM hotels WHERE id = ?').get(id);
    if (!h) throw new HttpError(404, 'Struttura non trovata.');
    return h;
  }

  function hotelOut(db, h, { withLogo = false } = {}) {
    const managers = db.prepare("SELECT id, name, email, active, must_change FROM users WHERE hotel_id = ? AND role = 'manager' ORDER BY name COLLATE NOCASE").all(h.id)
      .map((u) => ({ id: u.id, name: u.name, email: u.email, active: !!u.active, mustChange: !!u.must_change }));
    const staff = db.prepare("SELECT COUNT(*) n FROM users WHERE hotel_id = ? AND role = 'staff' AND active = 1").get(h.id).n;
    const last = db.prepare('SELECT MAX(updated_at) t FROM records WHERE hotel_id = ?').get(h.id).t || 0;
    const cfg = readConfig(db, h.id);
    return {
      id: h.id, code: h.code, name: h.name, active: !!h.active, createdAt: h.created_at,
      contactName: h.contact_name, contactEmail: h.contact_email, contactPhone: h.contact_phone,
      plan: h.plan, priceCents: h.price_cents, subStart: h.sub_start, subEnd: h.sub_end, notes: h.notes,
      status: subscriptionStatus(h), managers, staffCount: staff, lastActivity: last,
      hasLogo: !!cfg?.logo, ...(withLogo ? { logo: cfg?.logo || '' } : {}),
    };
  }

  /** Campi modificabili di una struttura, controllati. */
  function hotelFields(b) {
    const f = {};
    if (b.name !== undefined) { f.name = str(b.name, 80); if (!f.name) throw new HttpError(400, 'Il nome della struttura è obbligatorio.'); }
    for (const [k, col, max] of [['contactName', 'contact_name', 80], ['contactPhone', 'contact_phone', 40], ['plan', 'plan', 60], ['notes', 'notes', 2000]]) {
      if (b[k] !== undefined) f[col] = str(b[k], max);
    }
    if (b.contactEmail !== undefined) {
      f.contact_email = str(b.contactEmail, 200);
      if (f.contact_email && !EMAIL_RE.test(f.contact_email)) throw new HttpError(400, 'Email di contatto non valida.');
    }
    if (b.priceCents !== undefined) {
      if (!Number.isInteger(b.priceCents) || b.priceCents < 0 || b.priceCents > 10_000_000) throw new HttpError(400, 'Importo non valido.');
      f.price_cents = b.priceCents;
    }
    for (const [k, col] of [['subStart', 'sub_start'], ['subEnd', 'sub_end']]) {
      if (b[k] !== undefined) {
        f[col] = str(b[k], 10);
        if (!DATE_RE.test(f[col])) throw new HttpError(400, 'Data non valida.');
      }
    }
    return f;
  }

  function newManager(db, hotelId, name, email) {
    name = str(name, 60);
    email = str(email, 200).toLowerCase();
    if (!name) throw new HttpError(400, 'Inserisci il nome del manager.');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email del manager non valida.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Questa email è già usata da un altro account.');
    const password = A.generatePassword();
    const now = Date.now();
    db.prepare("INSERT INTO users (id, hotel_id, role, name, email, pass_hash, perms, active, must_change, created_at, updated_at) VALUES (?, ?, 'manager', ?, ?, ?, '{}', 1, 1, ?, ?)")
      .run(A.newId(), hotelId, name, email, A.hashSecret(password), now, now);
    return { email, password };
  }

  return [
    ['GET', /^\/api\/admin\/hotels$/, (ctx) => {
      isAdmin(ctx);
      const rows = ctx.db.prepare('SELECT * FROM hotels ORDER BY active DESC, name COLLATE NOCASE').all();
      return { hotels: rows.map((h) => hotelOut(ctx.db, h)) };
    }],

    ['GET', /^\/api\/admin\/hotels\/([0-9a-f-]{36})$/, (ctx) => {
      isAdmin(ctx);
      return { hotel: hotelOut(ctx.db, getHotelRow(ctx.db, ctx.params[0]), { withLogo: true }) };
    }],

    ['POST', /^\/api\/admin\/hotels$/, (ctx) => {
      isAdmin(ctx);
      const b = ctx.body;
      const f = hotelFields({ ...b, name: b.name ?? '' });
      const code = str(b.code, 40).toLowerCase();
      if (!CODE_RE.test(code)) throw new HttpError(400, 'Codice struttura: solo lettere minuscole, numeri e trattini (2-40).');
      if (ctx.db.prepare('SELECT 1 FROM hotels WHERE code = ?').get(code)) throw new HttpError(409, 'Codice struttura già usato.');
      const email = str(b.managerEmail, 200).toLowerCase();
      if (!str(b.managerName, 60)) throw new HttpError(400, 'Inserisci il nome del manager.');
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email del manager non valida.');
      if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Questa email è già usata da un altro account.');
      const password = A.generatePassword();
      const id = createHotel(ctx.db, {
        name: f.name, code, managerName: str(b.managerName, 60), managerEmail: email, password,
        fields: { contactName: f.contact_name, contactEmail: f.contact_email, contactPhone: f.contact_phone, plan: f.plan, priceCents: f.price_cents, subStart: f.sub_start, subEnd: f.sub_end, notes: f.notes },
      });
      return { hotel: hotelOut(ctx.db, getHotelRow(ctx.db, id)), credentials: { email, password, code } };
    }],

    ['PATCH', /^\/api\/admin\/hotels\/([0-9a-f-]{36})$/, (ctx) => {
      isAdmin(ctx);
      const h = getHotelRow(ctx.db, ctx.params[0]);
      const f = hotelFields(ctx.body);
      if (ctx.body.active !== undefined) f.active = ctx.body.active ? 1 : 0;
      const cols = Object.keys(f);
      if (cols.length) {
        ctx.db.prepare(`UPDATE hotels SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => f[c]), h.id);
      }
      // Struttura disattivata: tutti i suoi utenti escono
      if (f.active === 0) ctx.db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE hotel_id = ?)').run(h.id);
      return { hotel: hotelOut(ctx.db, getHotelRow(ctx.db, h.id), { withLogo: true }) };
    }],

    ['POST', /^\/api\/admin\/hotels\/([0-9a-f-]{36})\/logo$/, (ctx) => {
      isAdmin(ctx);
      const h = getHotelRow(ctx.db, ctx.params[0]);
      const logo = String(ctx.body.logo || '');
      if (logo && (!LOGO_RE.test(logo) || logo.length > MAX_LOGO)) throw new HttpError(400, 'Logo non valido o troppo grande.');
      tx(ctx.db, () => writeConfig(ctx.db, h.id, { logo }));
      return { hotel: hotelOut(ctx.db, h, { withLogo: true }) };
    }],

    ['POST', /^\/api\/admin\/hotels\/([0-9a-f-]{36})\/managers$/, (ctx) => {
      isAdmin(ctx);
      const h = getHotelRow(ctx.db, ctx.params[0]);
      const credentials = newManager(ctx.db, h.id, ctx.body.name, ctx.body.email);
      return { hotel: hotelOut(ctx.db, h), credentials: { ...credentials, code: h.code } };
    }],

    ['POST', /^\/api\/admin\/users\/([0-9a-f-]{36})\/reset$/, (ctx) => {
      isAdmin(ctx);
      const u = ctx.db.prepare("SELECT u.id, u.email, h.code FROM users u JOIN hotels h ON h.id = u.hotel_id WHERE u.id = ? AND u.role = 'manager'").get(ctx.params[0]);
      if (!u) throw new HttpError(404, 'Manager non trovato.');
      const password = A.generatePassword();
      ctx.db.prepare('UPDATE users SET pass_hash = ?, must_change = 1, active = 1, updated_at = ? WHERE id = ?').run(A.hashSecret(password), Date.now(), u.id);
      A.deleteUserSessions(ctx.db, u.id);
      A.clearFailures(ctx.db, `pwd:${u.email}`);
      return { credentials: { email: u.email, password, code: u.code } };
    }],
  ];
}
