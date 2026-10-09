/**
 * store.js — Logica dei dati dell'app ("servizio dati").
 *
 * L'interfaccia (app.js) usa SOLO queste funzioni, mai IndexedDB direttamente.
 * Per collegare un backend in futuro si sostituisce l'import di './db.js'
 * con un adattatore che offra getAll/get/putMany/clear, lasciando invariata
 * l'interfaccia.
 *
 * Modello dei dati (tutti i record hanno id, updatedAt, device):
 *  - locations     camere e postazioni extra (etichetta, nome ospite corrente)
 *  - products      listino (nome, prezzo in centesimi, categoria, IVA)
 *  - consumptions  righe addebitate; accountId = null finché il conto è aperto
 *  - accounts      conti chiusi (archivio, con copia di camera e ospite)
 *  - meta          impostazioni di questo dispositivo (non vengono esportate)
 */

import * as db from './db.js';
import * as M from './model.js';

const SETTINGS_ID = 'settings';
let settingsCache = null;

/**
 * Coda delle scritture: le operazioni che leggono e poi scrivono (es. due
 * tocchi rapidi sullo stesso prodotto) vengono eseguite una alla volta,
 * altrimenti entrambe leggerebbero lo stato vecchio.
 */
let queue = Promise.resolve();
function serial(fn) {
  return (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };
}

// ---------------------------------------------------------------------------
// Avvio e impostazioni del dispositivo
// ---------------------------------------------------------------------------

/** Apre il database e, al primo avvio, carica camere e listino di esempio. */
export async function init() {
  await db.open();
  const s = await db.get('meta', SETTINGS_ID);
  if (!s) {
    settingsCache = {
      id: SETTINGS_ID,
      deviceName: 'Dispositivo-' + M.uuid().slice(0, 4).toUpperCase(),
      pinHash: '',
      lastExportAt: 0,
      createdAt: Date.now(),
    };
    await db.putMany({
      meta: [settingsCache],
      locations: M.defaultLocations(),
      products: M.defaultProducts(),
    });
  } else {
    settingsCache = s;
  }
  // Aggiornamento dalla versione 1.0: aggiunge le tariffe di soggiorno se mancano.
  const missing = [];
  for (const p of M.defaultStayProducts()) if (!(await db.get('products', p.id))) missing.push(p);
  await db.putMany({ products: missing });
  return settingsCache;
}

export function getSettings() {
  return { ...settingsCache };
}

export async function saveSettings(patch) {
  settingsCache = { ...settingsCache, ...patch };
  await db.put('meta', settingsCache);
  return getSettings();
}

function device() {
  return settingsCache?.deviceName || 'sconosciuto';
}

// ---------------------------------------------------------------------------
// PIN (facoltativo). È un deterrente per l'uso quotidiano, non una protezione
// crittografica: i dati restano comunque leggibili da chi ha il dispositivo.
// ---------------------------------------------------------------------------

async function hashPin(pin) {
  const text = 'bucaneve:' + pin;
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return 'sha256:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Ripiego se la pagina non è servita in HTTPS (crypto.subtle non disponibile).
  let h = 5381;
  for (const c of text) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return 'djb2:' + h.toString(16);
}

export function hasPin() {
  return !!settingsCache?.pinHash;
}

export async function setPin(pin) {
  await saveSettings({ pinHash: pin ? await hashPin(pin) : '' });
}

export async function checkPin(pin) {
  if (!hasPin()) return true;
  return (await hashPin(pin)) === settingsCache.pinHash;
}

// ---------------------------------------------------------------------------
// Camere e postazioni
// ---------------------------------------------------------------------------

const byOrder = (a, b) => (a.order - b.order) || String(a.label).localeCompare(String(b.label), 'it', { numeric: true });

export async function listLocations({ includeInactive = false } = {}) {
  const all = await db.getAll('locations');
  return all.filter((l) => includeInactive || l.active !== false).sort(byOrder);
}

export function getLocation(id) {
  return db.get('locations', id);
}

export const updateLocation = serial(async (id, patch) => {
  const cur = await db.get('locations', id);
  if (!cur) throw new Error('Postazione non trovata');
  const rec = M.stamp({ ...cur, ...patch }, device());
  await db.put('locations', rec);
  return rec;
});

export async function addLocation(kind, label) {
  const all = await db.getAll('locations');
  const maxOrder = Math.max(0, ...all.filter((l) => l.kind === kind).map((l) => l.order || 0));
  const rec = M.stamp({
    id: M.uuid(), kind, label: String(label).trim(),
    order: Math.max(maxOrder + 1, kind === 'extra' ? 101 : 1),
    active: true, guestName: '',
  }, device());
  await db.put('locations', rec);
  return rec;
}

export function setGuestName(locationId, guestName) {
  return updateLocation(locationId, { guestName: String(guestName || '').trim() });
}

export function setGuestEmail(locationId, guestEmail) {
  return updateLocation(locationId, { guestEmail: String(guestEmail || '').trim() });
}

// ---------------------------------------------------------------------------
// Dati della struttura (sincronizzati: valgono per tutti i dispositivi)
// ---------------------------------------------------------------------------

export async function getHotel() {
  return { ...M.defaultHotel(), ...((await db.get('config', M.HOTEL_ID)) || {}) };
}

const HOTEL_FIELDS = ['name', 'place', 'company', 'address', 'vatNumber', 'phone', 'email', 'logo', 'footer'];

export const saveHotel = serial(async (patch) => {
  const cur = await getHotel();
  const clean = {};
  for (const k of HOTEL_FIELDS) if (k in patch) clean[k] = String(patch[k] ?? '').trim();
  if ('name' in clean && !clean.name) throw new Error('Il nome della struttura non può essere vuoto.');
  const rec = M.stamp({ ...cur, ...clean }, device());
  await db.put('config', rec);
  return rec;
});

// ---------------------------------------------------------------------------
// Listino
// ---------------------------------------------------------------------------

/** Prodotti del bar (le tariffe di soggiorno sono escluse: vedi listStayRates). */
export async function listProducts({ includeInactive = false } = {}) {
  const all = await db.getAll('products');
  return all
    .filter((p) => p.category !== M.STAY_CATEGORY && (includeInactive || p.active !== false))
    .sort((a, b) => a.order - b.order);
}

/** Tariffe delle voci di soggiorno, indicizzate per tipo: { room, pet, tax }. */
export async function listStayRates() {
  const rates = {};
  for (const [type, t] of Object.entries(M.STAY_TYPES)) rates[type] = await db.get('products', t.id);
  return rates;
}

/** Modifica prezzo e IVA di una voce di soggiorno (nome e tipo restano fissi). */
export const saveStayRate = serial(async (type, { price, vat }) => {
  const cur = await db.get('products', M.STAY_TYPES[type].id);
  if (!cur) throw new Error('Voce di soggiorno non trovata');
  if (!Number.isInteger(price) || price < 0) throw new Error('Prezzo non valido.');
  if (!M.VAT_RATES.includes(vat)) throw new Error('Aliquota IVA non valida.');
  const rec = M.stamp({ ...cur, price, vat }, device());
  await db.put('products', rec);
  return rec;
});

/** Crea o modifica un prodotto. I prodotti eliminati restano come "non attivi". */
export const saveProduct = serial(async (data) => {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Inserisci il nome del prodotto.');
  if (!Number.isInteger(data.price) || data.price < 0) throw new Error('Prezzo non valido.');
  if (!M.VAT_RATES.includes(data.vat)) throw new Error('Aliquota IVA non valida.');
  if (!M.CATEGORIES.some((c) => c.id === data.category)) throw new Error('Categoria non valida.');

  let cur = data.id ? await db.get('products', data.id) : null;
  if (!cur) {
    const all = await db.getAll('products');
    cur = { id: M.uuid(), order: Math.max(0, ...all.map((p) => p.order || 0)) + 1, active: true };
  }
  const rec = M.stamp({ ...cur, name, price: data.price, vat: data.vat, category: data.category, active: data.active ?? cur.active }, device());
  await db.put('products', rec);
  return rec;
});

export const setProductActive = serial(async (id, active) => {
  const cur = await db.get('products', id);
  if (!cur) return;
  await db.put('products', M.stamp({ ...cur, active }, device()));
});

// ---------------------------------------------------------------------------
// Consumazioni e conti aperti
// ---------------------------------------------------------------------------

const byCreated = (a, b) => a.createdAt - b.createdAt;

/** Righe del conto aperto di una postazione (comprese quelle annullate). */
export async function openLines(locationId) {
  const all = await db.getAll('consumptions');
  return all.filter((c) => c.locationId === locationId && !c.accountId).sort(byCreated);
}

/**
 * Situazione di tutti i conti aperti, per la griglia.
 * @returns {Map<string, {total:number, count:number, lines:number}>}
 */
export async function openSummary() {
  const all = await db.getAll('consumptions');
  const map = new Map();
  for (const c of all) {
    if (c.accountId) continue;
    const s = map.get(c.locationId) || { total: 0, count: 0, lines: 0 };
    s.lines++;
    if (!c.cancelled) { s.total += M.lineTotal(c); s.count += c.qty; }
    map.set(c.locationId, s);
  }
  return map;
}

/**
 * Aggiunta rapida: se lo stesso prodotto è già stato aggiunto (non annullato)
 * negli ultimi minuti a questo conto, aumenta la quantità; altrimenti crea una
 * nuova riga. Nome, prezzo e IVA vengono copiati nella riga, così modifiche
 * successive al listino non alterano i conti già registrati.
 * @returns {{line: object, merged: boolean}}
 */
export const addConsumption = serial(async (locationId, productId, now = Date.now()) => {
  const product = await db.get('products', productId);
  if (!product) throw new Error('Prodotto non trovato');
  const lines = await openLines(locationId);
  const recent = lines
    .filter((l) => !l.cancelled && l.productId === productId && l.price === product.price && now - l.createdAt < M.MERGE_WINDOW_MS)
    .pop();
  let line;
  if (recent) {
    line = M.stamp({ ...recent, qty: recent.qty + 1 }, device(), now);
  } else {
    line = M.stamp({
      id: M.uuid(), locationId, accountId: null,
      productId, name: product.name, category: product.category, price: product.price, vat: product.vat,
      qty: 1, createdAt: now, cancelled: false, cancelledAt: null,
    }, device(), now);
  }
  await db.put('consumptions', line);
  return { line, merged: !!recent };
});

/**
 * Aggiunge al conto una voce di soggiorno (conto camera, animale, tassa).
 * Quantità = notti (per la tassa: persone × notti); prezzo unitario e IVA
 * vengono copiati nella riga come per le consumazioni.
 * @param {'room'|'pet'|'tax'} type
 */
export const addStayCharge = serial(async (locationId, type, { nights, persons = 1, price, vat }) => {
  const t = M.STAY_TYPES[type];
  if (!t) throw new Error('Voce di soggiorno non valida');
  if (!Number.isInteger(nights) || nights < 1) throw new Error('Indica il numero di notti.');
  if (type === 'tax' && (!Number.isInteger(persons) || persons < 1)) throw new Error('Indica il numero di persone.');
  if (!Number.isInteger(price) || price <= 0) throw new Error('Indica un importo maggiore di zero.');
  if (!M.VAT_RATES.includes(vat)) throw new Error('Aliquota IVA non valida.');
  const now = Date.now();
  const line = M.stamp({
    id: M.uuid(), locationId, accountId: null,
    productId: t.id, name: M.stayLineName(type, nights, persons), category: M.STAY_CATEGORY,
    price, vat, qty: type === 'tax' ? nights * persons : nights,
    createdAt: now, cancelled: false, cancelledAt: null,
  }, device(), now);
  await db.put('consumptions', line);
  return line;
});

/** Aumenta di 1 la quantità di una riga aperta. */
export const incrementLine = serial(async (id) => {
  const cur = await db.get('consumptions', id);
  if (!cur || cur.accountId || cur.cancelled) return null;
  const rec = M.stamp({ ...cur, qty: cur.qty + 1 }, device());
  await db.put('consumptions', rec);
  return rec;
});

/** Imposta la quantità esatta (es. da 4 a 3); 0 annulla la riga. */
export const setLineQty = serial(async (id, qty) => {
  const cur = await db.get('consumptions', id);
  if (!cur || cur.accountId || cur.cancelled) return null;
  if (!Number.isInteger(qty) || qty < 0 || qty > 999) throw new Error('Quantità non valida.');
  if (qty === 0) return doCancel(cur);
  if (qty === cur.qty) return cur;
  const rec = M.stamp({ ...cur, qty }, device());
  await db.put('consumptions', rec);
  return rec;
});

/**
 * Toglie un pezzo di un prodotto dal conto aperto, partendo dalla riga più
 * recente (il "−" sul pulsante del prodotto). Se la riga aveva quantità 1
 * viene annullata. Restituisce la riga modificata o null.
 */
export const removeOneOfProduct = serial(async (locationId, productId) => {
  const lines = (await openLines(locationId)).filter((l) => !l.cancelled && l.productId === productId);
  const cur = lines.pop();
  if (!cur) return null;
  if (cur.qty <= 1) return doCancel(cur);
  const rec = M.stamp({ ...cur, qty: cur.qty - 1 }, device());
  await db.put('consumptions', rec);
  return rec;
});

/** Diminuisce di 1 la quantità; se era 1 la riga viene annullata. */
export const decrementLine = serial(async (id) => {
  const cur = await db.get('consumptions', id);
  if (!cur || cur.accountId || cur.cancelled) return null;
  if (cur.qty <= 1) return doCancel(cur);
  const rec = M.stamp({ ...cur, qty: cur.qty - 1 }, device());
  await db.put('consumptions', rec);
  return rec;
});

/** Annulla una riga: non viene cancellata, resta nello storico come annullata. */
export const cancelLine = serial(async (id) => {
  const cur = await db.get('consumptions', id);
  if (!cur || cur.accountId || cur.cancelled) return null;
  return doCancel(cur);
});

async function doCancel(cur) {
  const rec = M.stamp({ ...cur, cancelled: true, cancelledAt: Date.now(), cancelledBy: device() }, device());
  await db.put('consumptions', rec);
  return rec;
}

/**
 * Chiude il conto: crea un record in "accounts", collega le righe al conto
 * e libera la postazione (svuota il nome ospite). Tutto in una transazione.
 */
export const closeAccount = serial(async (locationId) => {
  const loc = await db.get('locations', locationId);
  const lines = await openLines(locationId);
  if (!loc) throw new Error('Postazione non trovata');
  if (!lines.length) throw new Error('Non ci sono consumazioni da chiudere.');
  const now = Date.now();
  const totals = M.computeTotals(lines);
  const account = M.stamp({
    id: M.uuid(),
    locationId,
    locationName: M.locationName(loc),
    guestName: loc.guestName || '',
    guestEmail: loc.guestEmail || '',
    openedAt: lines[0].createdAt,
    closedAt: now,
    closedBy: device(),
    total: totals.total,
    lineCount: lines.length,
  }, device(), now);
  await db.putMany({
    accounts: [account],
    consumptions: lines.map((l) => M.stamp({ ...l, accountId: account.id }, device(), now)),
    locations: [M.stamp({ ...loc, guestName: '', guestEmail: '' }, device(), now)],
  });
  return account;
});

// ---------------------------------------------------------------------------
// Storico conti chiusi
// ---------------------------------------------------------------------------

/** Conti chiusi tra due date "AAAA-MM-GG" (comprese), dal più recente. */
export async function listAccounts(fromKey, toKey) {
  const all = await db.getAll('accounts');
  const { from, to } = M.dayRange(fromKey, toKey);
  return all.filter((a) => a.closedAt >= from && a.closedAt <= to).sort((a, b) => b.closedAt - a.closedAt);
}

export function getAccount(id) {
  return db.get('accounts', id);
}

export async function accountLines(accountId) {
  const all = await db.getAll('consumptions');
  return all.filter((c) => c.accountId === accountId).sort(byCreated);
}

// ---------------------------------------------------------------------------
// Esportazione / importazione / CSV
// ---------------------------------------------------------------------------

const SYNCED = ['locations', 'products', 'consumptions', 'accounts', 'config'];

/** Tutti i dati condivisi (le impostazioni del dispositivo e il PIN restano locali). */
export async function exportData() {
  const data = {};
  for (const name of SYNCED) data[name] = await db.getAll(name);
  const now = Date.now();
  return {
    payload: { app: M.APP_ID, version: M.EXPORT_VERSION, exportedAt: now, device: device(), data },
    fileName: M.exportFileName(device(), now),
  };
}

export function markExported(ts = Date.now()) {
  return saveSettings({ lastExportAt: ts });
}

/**
 * Unisce un'esportazione ai dati locali, senza duplicare (stesso id = stesso
 * record) e facendo vincere la modifica più recente.
 * @returns riepilogo di cosa è stato aggiunto/aggiornato
 */
export const importData = serial(async (obj) => {
  M.validateExport(obj);
  const result = { from: obj.device || '?', exportedAt: obj.exportedAt || 0, stores: {} };
  const changes = {};
  for (const name of SYNCED) {
    const merged = M.mergeRecords(await db.getAll(name), obj.data[name] || []);
    changes[name] = merged.toWrite;
    result.stores[name] = merged;
  }
  await db.putMany(changes);

  // Dettaglio leggibile: nuove consumazioni per postazione e nuovi conti chiusi.
  const locs = new Map((await db.getAll('locations')).map((l) => [l.id, l]));
  const perLocation = new Map();
  for (const c of result.stores.consumptions.added) {
    const key = c.accountId ? null : c.locationId;
    if (!key) continue;
    const s = perLocation.get(key) || { name: M.locationName(locs.get(key)), lines: 0, total: 0 };
    s.lines++;
    if (!c.cancelled) s.total += M.lineTotal(c);
    perLocation.set(key, s);
  }
  result.openByLocation = [...perLocation.values()];
  result.newAccounts = result.stores.accounts.added.slice().sort((a, b) => a.closedAt - b.closedAt);
  return result;
});

/** CSV dei conti chiusi in un intervallo di date. */
export async function exportCsv(fromKey, toKey) {
  const accounts = await listAccounts(fromKey, toKey);
  const ids = new Set(accounts.map((a) => a.id));
  const lines = (await db.getAll('consumptions')).filter((c) => ids.has(c.accountId));
  return {
    csv: M.buildCsv(accounts, lines),
    fileName: `${M.APP_ID}_conti_${fromKey}_${toKey}.csv`,
    accounts: accounts.length,
  };
}

/** Cancella tutti i dati di questo dispositivo e riparte da zero (tiene il nome dispositivo). */
export async function resetAll() {
  const deviceName = device();
  await db.clear();
  settingsCache = null;
  await init();
  return saveSettings({ deviceName });
}
