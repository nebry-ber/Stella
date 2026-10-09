/**
 * sync.js — Collegamento al server e sincronizzazione automatica.
 *
 * L'app funziona in due modalità:
 *  - "standalone": nessun server (es. GitHub Pages). I dati si scambiano a
 *    mano con i file di esportazione, come nella prima versione.
 *  - "server": l'app è servita dal server Stella (es. stella-app.cumulonembo.com).
 *    Serve l'accesso; ogni modifica locale finisce nell'outbox e viene inviata
 *    in pochi istanti, e ogni 10 secondi si scaricano le novità degli altri.
 *    Senza rete si continua a lavorare: le modifiche partono appena torna.
 *
 * La modalità si riconosce da sola chiedendo /api/me al primo avvio.
 */

import * as db from './db.js';
import { isNewer } from './model.js';

const META_ID = 'sync';
const POLL_MS = 10_000;
const BATCH = 1000;

const state = {
  mode: 'standalone', // 'standalone' | 'server'
  user: null,         // utente collegato (server)
  status: 'idle',     // 'idle' | 'syncing' | 'ok' | 'offline' | 'error'
  error: '',
  pending: 0,         // modifiche locali non ancora inviate
  lastSyncAt: 0,
};
const listeners = { status: new Set(), data: new Set(), logout: new Set() };

export function on(event, fn) { listeners[event].add(fn); return () => listeners[event].delete(fn); }
function emit(event, payload) { for (const fn of listeners[event]) { try { fn(payload); } catch (e) { console.error(e); } } }
function setStatus(patch) { Object.assign(state, patch); emit('status', getState()); }

export function getState() { return { ...state }; }
export const isServer = () => state.mode === 'server';
export const user = () => state.user;

/** Permesso dell'utente collegato (in modalità standalone tutto è permesso). */
export function can(perm) {
  if (!isServer()) return true;
  return !!state.user?.perms?.[perm];
}

// ---------------------------------------------------------------------------
// Chiamate al server
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Chiamata JSON alle API. Lancia ApiError (status 0 = rete assente). */
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Nessuna connessione al server.', 0);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : {};
  if (!res.ok) throw new ApiError(data.error || `Errore del server (${res.status}).`, res.status);
  if (!isJson) throw new ApiError('Risposta non valida dal server.', res.status);
  return data;
}

async function getMeta() {
  return (await db.get('meta', META_ID)) || { id: META_ID, cursor: 0, hotelId: null, user: null, lastSyncAt: 0 };
}
async function saveMeta(patch) {
  const m = { ...(await getMeta()), ...patch };
  await db.put('meta', m);
  return m;
}

/**
 * Riconosce la modalità. Se il server non risponde (offline) ma il
 * dispositivo era già collegato, resta in modalità server con l'ultimo
 * utente noto, così si può lavorare offline.
 */
export async function detect() {
  const meta = await getMeta();
  // Sito statico già riconosciuto (es. GitHub Pages): niente richiesta inutile
  if (meta.mode === 'standalone') {
    state.pending = await db.count('outbox');
    return getState();
  }
  try {
    const { user } = await api('GET', 'me');
    setStatus({ mode: 'server', user });
    await saveMeta({ user });
  } catch (e) {
    if (e.status === 401) setStatus({ mode: 'server', user: null });
    else if (e.status === 0 && meta.user) setStatus({ mode: 'server', user: meta.user, status: 'offline' });
    else if (e.status === 404) { setStatus({ mode: 'standalone', user: null }); await saveMeta({ mode: 'standalone' }); } // sito statico
    else setStatus({ mode: 'standalone', user: null });
  }
  state.lastSyncAt = meta.lastSyncAt || 0;
  state.pending = await db.count('outbox');
  return getState();
}

// ---------------------------------------------------------------------------
// Accesso / uscita
// ---------------------------------------------------------------------------

/** Aggiorna l'utente collegato (es. dopo il cambio della password provvisoria). */
export async function setUser(user) {
  setStatus({ mode: 'server', user });
  await saveMeta({ user });
}

/**
 * Da chiamare dopo un accesso riuscito. Se il dispositivo conteneva dati di
 * un'altra struttura (o di prova) li cancella, poi scarica tutto dal server.
 * @param resetLocal funzione che svuota gli archivi condivisi locali
 */
export async function onLogin(user, { resetLocal, seedIfEmpty }) {
  const meta = await getMeta();
  if (meta.hotelId !== user.hotel.id) {
    await resetLocal();
    await db.clear(['outbox']);
    await saveMeta({ hotelId: user.hotel.id, cursor: 0, lastSyncAt: 0 });
  }
  await saveMeta({ user });
  setStatus({ mode: 'server', user, pending: await db.count('outbox') });
  await syncNow();
  if (state.status === 'ok') await seedIfEmpty(user);
}

/** Esce: prova a inviare le modifiche in sospeso, poi chiude la sessione. */
export async function logout({ resetLocal }) {
  await syncNow();
  try { await api('POST', 'logout', {}); } catch { /* offline: la sessione scadrà da sola */ }
  await resetLocal();
  await db.clear(['outbox']);
  await saveMeta({ hotelId: null, cursor: 0, user: null, lastSyncAt: 0 });
  setStatus({ user: null, pending: 0, status: 'idle' });
}

// ---------------------------------------------------------------------------
// Sincronizzazione
// ---------------------------------------------------------------------------

let running = false;
let again = false;

/** Invia le modifiche locali e scarica quelle degli altri dispositivi. */
export async function syncNow() {
  // L'amministratore non ha una struttura; con la password provvisoria si aspetta il cambio
  if (!isServer() || !state.user?.hotel || state.user.mustChange) return;
  if (running) { again = true; return; }
  running = true;
  setStatus({ status: 'syncing' });
  try {
    let more = true;
    while (more) {
      const outbox = (await db.getAll('outbox')).slice(0, BATCH);
      const changes = {};
      const sent = [];
      for (const e of outbox) {
        const rec = await db.get(e.store, e.recId);
        sent.push({ entry: e, updatedAt: rec?.updatedAt });
        if (rec) (changes[e.store] ||= []).push(rec);
      }
      const meta = await getMeta();
      const res = await api('POST', 'sync', { cursor: meta.cursor || 0, changes });
      const wrote = await applyIncoming(res.changes || {}, res.rejected || []);
      // Tolgo dall'outbox solo ciò che non è cambiato nel frattempo
      const done = [];
      for (const s of sent) {
        const rec = await db.get(s.entry.store, s.entry.recId);
        if (!rec || rec.updatedAt === s.updatedAt) done.push(s.entry.id);
      }
      await db.deleteMany({ outbox: done });
      await saveMeta({ cursor: res.cursor, lastSyncAt: Date.now(), user: res.user });
      state.user = res.user || state.user;
      if (wrote) emit('data');
      more = res.more || outbox.length === BATCH;
    }
    setStatus({ status: 'ok', error: '', lastSyncAt: Date.now(), pending: await db.count('outbox') });
  } catch (e) {
    const pending = await db.count('outbox');
    if (e.status === 401) {
      setStatus({ user: null, status: 'idle', pending });
      emit('logout');
    } else if (e.status === 0) {
      setStatus({ status: 'offline', pending });
    } else {
      console.error(e);
      setStatus({ status: 'error', error: e.message, pending });
    }
  } finally {
    running = false;
    if (again) { again = false; syncNow(); }
  }
}

/**
 * Scrive i record arrivati dal server. Di norma vince il più recente; per i
 * record rifiutati (permessi) vale sempre la versione del server, e se il
 * server non ne ha una il record locale viene eliminato.
 * @returns {boolean} true se è cambiato qualcosa
 */
async function applyIncoming(changes, rejected) {
  const forced = new Set(rejected.map((r) => `${r.store}/${r.id}`));
  let wrote = false;
  for (const [store, list] of Object.entries(changes)) {
    if (!db.SYNCED_STORES.includes(store)) continue;
    const toWrite = [];
    for (const rec of list) {
      const local = await db.get(store, rec.id);
      if (forced.has(`${store}/${rec.id}`) || isNewer(rec, local)) toWrite.push(rec);
      forced.delete(`${store}/${rec.id}`);
    }
    if (toWrite.length) { await db.putMany({ [store]: toWrite }, { remote: true }); wrote = true; }
  }
  // Rifiutati senza versione sul server: il dato locale non può esistere
  const drop = {};
  for (const key of forced) {
    const [store, id] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
    if (db.SYNCED_STORES.includes(store)) (drop[store] ||= []).push(id);
  }
  if (Object.keys(drop).length) { await db.deleteMany(drop); wrote = true; }
  return wrote;
}

let debounceTimer = null;
let started = false;

/** Avvia la sincronizzazione automatica (dopo ogni modifica, ogni 10 s, al ritorno della rete). */
export function start() {
  if (started) return;
  started = true;
  db.setWriteListener(() => {
    db.count('outbox').then((n) => setStatus({ pending: n }));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(syncNow, 500);
  });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, POLL_MS);
  window.addEventListener('online', syncNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
}
