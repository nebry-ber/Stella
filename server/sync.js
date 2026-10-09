/**
 * server/sync.js — Sincronizzazione tra dispositivi.
 *
 * Il dispositivo invia le proprie modifiche (push) e riceve quelle degli
 * altri (pull) in un'unica richiesta. Regole:
 *  - ogni record è identificato da (archivio, id) e porta updatedAt + device;
 *  - vince la modifica più recente (stessa funzione isNewer usata nell'app);
 *  - i dipendenti possono scrivere solo ciò che i loro permessi consentono:
 *    il resto viene rifiutato e il dispositivo riceve la versione del server.
 */

import { isNewer } from '../js/model.js';
import { tx, nextSeq } from './db.js';

export const SYNC_STORES = ['locations', 'products', 'consumptions', 'accounts', 'config'];
export const MAX_RECORDS_PER_PUSH = 5000;
const MAX_RECORD_BYTES = 400_000; // il logo incorporato può pesare qualche centinaio di KB
const PULL_LIMIT = 1000;

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/** Controllo di forma minimo: rifiuta dati malformati prima di salvarli. */
function validate(store, rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'record non valido';
  if (typeof rec.id !== 'string' || !rec.id || rec.id.length > 120) return 'id non valido';
  if (!Number.isFinite(rec.updatedAt) || rec.updatedAt < 0) return 'updatedAt non valido';
  if (store === 'consumptions') {
    if (typeof rec.locationId !== 'string') return 'postazione mancante';
    if (!isInt(rec.qty, 0, 9999) || !isInt(rec.price, 0, 100_000_000)) return 'quantità o prezzo non validi';
  }
  if (store === 'products' && !isInt(rec.price, 0, 100_000_000)) return 'prezzo non valido';
  return null;
}

/** JSON con chiavi ordinate, per confrontare due record ignorando l'ordine. */
function stable(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function sameExcept(a, b, fields) {
  const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !fields.includes(k)));
  return stable(strip(a)) === stable(strip(b));
}

/** Il dipendente può scrivere questo record? (manager e admin: sempre) */
export function canWrite(user, store, incoming, current) {
  if (user.role !== 'staff') return true;
  const p = user.perms;
  switch (store) {
    case 'consumptions':
      // Chiudere un conto (collegare la riga a un conto) richiede il permesso
      if (incoming.accountId && incoming.accountId !== (current?.accountId ?? null)) return !!p.closeAccounts;
      return !current?.accountId; // le righe di conti già chiusi non si toccano
    case 'accounts':
      return !!p.closeAccounts;
    case 'products':
      if (p.editPrices) return true;
      // Le tariffe di soggiorno rientrano nei "dati struttura"
      return !!p.editSettings && incoming.category === 'soggiorno' && current?.category === 'soggiorno';
    case 'config':
      return !!p.editSettings;
    case 'locations':
      if (p.editRooms) return true;
      // Senza permesso si può cambiare solo il nome/email dell'ospite di una camera esistente
      return !!current && sameExcept(incoming, current, ['guestName', 'guestEmail', 'updatedAt', 'device']);
    default:
      return false;
  }
}

/**
 * Salva le modifiche inviate da un dispositivo.
 * @returns {{ back: Array<{store, rec}>, rejected: Array<{store, id, reason}>, written: number }}
 *   back = versioni del server da rimandare al dispositivo (più recenti o rifiuti)
 */
export function applyChanges(db, user, changes) {
  const out = { back: [], rejected: [], written: 0 };
  if (!changes || typeof changes !== 'object') return out;
  const hotelId = user.hotel.id;
  const getStmt = db.prepare('SELECT data FROM records WHERE hotel_id = ? AND store = ? AND id = ?');
  const putStmt = db.prepare(`
    INSERT INTO records (hotel_id, store, id, data, updated_at, device, seq) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hotel_id, store, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, device = excluded.device, seq = excluded.seq`);

  tx(db, () => {
    for (const store of SYNC_STORES) {
      const list = changes[store];
      if (!Array.isArray(list)) continue;
      for (const rec of list) {
        const err = validate(store, rec);
        if (err) { out.rejected.push({ store, id: rec?.id ?? null, reason: err }); continue; }
        const json = JSON.stringify(rec);
        if (Buffer.byteLength(json) > MAX_RECORD_BYTES) { out.rejected.push({ store, id: rec.id, reason: 'record troppo grande' }); continue; }
        const row = getStmt.get(hotelId, store, rec.id);
        const current = row ? JSON.parse(row.data) : null;
        if (!canWrite(user, store, rec, current)) {
          out.rejected.push({ store, id: rec.id, reason: 'permesso negato' });
          if (current) out.back.push({ store, rec: current });
          continue;
        }
        if (!isNewer(rec, current)) {
          // Il server ha già una versione uguale o più recente: la rimanda se diversa
          if (current && (current.updatedAt !== rec.updatedAt || current.device !== rec.device)) out.back.push({ store, rec: current });
          continue;
        }
        putStmt.run(hotelId, store, rec.id, json, Math.floor(rec.updatedAt), String(rec.device || '').slice(0, 80), nextSeq(db));
        out.written++;
      }
    }
  });
  return out;
}

/** Record cambiati dopo il cursore indicato, a blocchi. */
export function pullChanges(db, hotelId, cursor) {
  const rows = db.prepare('SELECT store, data, seq FROM records WHERE hotel_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(hotelId, Math.max(0, Number(cursor) || 0), PULL_LIMIT + 1);
  const more = rows.length > PULL_LIMIT;
  const page = more ? rows.slice(0, PULL_LIMIT) : rows;
  const changes = {};
  for (const r of page) (changes[r.store] ||= []).push(JSON.parse(r.data));
  const last = page.length ? page[page.length - 1].seq : Math.max(0, Number(cursor) || 0);
  return { changes, cursor: last, more };
}

/** Tutti i record di un archivio per un hotel (per statistiche e dashboard). */
export function readStore(db, hotelId, store) {
  return db.prepare('SELECT data FROM records WHERE hotel_id = ? AND store = ?').all(hotelId, store).map((r) => JSON.parse(r.data));
}
