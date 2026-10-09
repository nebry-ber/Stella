/**
 * db.js — Adattatore di persistenza basato su IndexedDB.
 *
 * È l'unico file che parla con IndexedDB. Espone poche operazioni generiche
 * (leggi tutto, leggi uno, scrivi in blocco, svuota). Per passare in futuro a
 * un backend basta scrivere un altro modulo con le stesse funzioni
 * (ad esempio chiamate fetch() verso un'API) e importarlo in store.js.
 */

const DB_NAME = 'bucaneve';
const DB_VERSION = 3; // 2: archivio "config" (dati struttura) · 3: archivio "outbox"

/** Archivi (tabelle) usati dall'app. Tutti hanno chiave primaria "id". */
export const STORES = ['locations', 'products', 'consumptions', 'accounts', 'config', 'meta', 'outbox'];

/** Archivi condivisi tra dispositivi (sincronizzati con il server o via file). */
export const SYNCED_STORES = ['locations', 'products', 'consumptions', 'accounts', 'config'];

/**
 * "outbox": elenco delle modifiche fatte su questo dispositivo e non ancora
 * inviate al server. Ogni scrittura locale su un archivio condiviso aggiunge
 * qui una voce, nella stessa transazione; le scritture che arrivano dal server
 * (remote: true) no. Il motore di sincronizzazione (sync.js) la svuota.
 */
let writeListener = null;
export function setWriteListener(fn) {
  writeListener = fn;
}

let dbPromise = null;

/** Apre (o crea) il database. Le chiamate successive riusano la connessione. */
export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database bloccato da un\'altra scheda aperta.'));
  });
  return dbPromise;
}

/** Trasforma una IDBRequest in una Promise. */
function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Attende la fine di una transazione. */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transazione annullata'));
  });
}

/** Restituisce tutti i record di un archivio. */
export async function getAll(store) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).getAll());
}

/** Restituisce un record per id (o undefined). */
export async function get(store, id) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(id));
}

/**
 * Scrive più record in più archivi in un'unica transazione atomica:
 * o vengono salvati tutti, o nessuno.
 * @param {Object<string, Array<object>>} changes es. { accounts: [...], consumptions: [...] }
 * @param {{remote?: boolean}} options remote: true per i dati arrivati dal server
 */
export async function putMany(changes, { remote = false } = {}) {
  const names = Object.keys(changes).filter((k) => changes[k] && changes[k].length);
  if (!names.length) return;
  const track = !remote && names.some((n) => SYNCED_STORES.includes(n));
  const db = await open();
  const tx = db.transaction(track ? [...names, 'outbox'] : names, 'readwrite');
  for (const name of names) {
    const os = tx.objectStore(name);
    for (const rec of changes[name]) os.put(rec);
    if (track && SYNCED_STORES.includes(name)) {
      const ob = tx.objectStore('outbox');
      for (const rec of changes[name]) ob.put({ id: `${name}/${rec.id}`, store: name, recId: rec.id });
    }
  }
  await txDone(tx);
  if (track && writeListener) writeListener();
}

/** Elimina record per id: { archivio: [id, ...] }. */
export async function deleteMany(changes) {
  const names = Object.keys(changes).filter((k) => changes[k] && changes[k].length);
  if (!names.length) return;
  const db = await open();
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) for (const id of changes[name]) tx.objectStore(name).delete(id);
  await txDone(tx);
}

/** Numero di record in un archivio. */
export async function count(store) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).count());
}

/** Scrive un singolo record. */
export function put(store, rec, options) {
  return putMany({ [store]: [rec] }, options);
}

/** Svuota gli archivi indicati (di default tutti). */
export async function clear(names = STORES) {
  const db = await open();
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) tx.objectStore(name).clear();
  await txDone(tx);
}
