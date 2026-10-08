/**
 * db.js — Adattatore di persistenza basato su IndexedDB.
 *
 * È l'unico file che parla con IndexedDB. Espone poche operazioni generiche
 * (leggi tutto, leggi uno, scrivi in blocco, svuota). Per passare in futuro a
 * un backend basta scrivere un altro modulo con le stesse funzioni
 * (ad esempio chiamate fetch() verso un'API) e importarlo in store.js.
 */

const DB_NAME = 'bucaneve';
const DB_VERSION = 1;

/** Archivi (tabelle) usati dall'app. Tutti hanno chiave primaria "id". */
export const STORES = ['locations', 'products', 'consumptions', 'accounts', 'meta'];

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
 */
export async function putMany(changes) {
  const names = Object.keys(changes).filter((k) => changes[k] && changes[k].length);
  if (!names.length) return;
  const db = await open();
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) {
    const os = tx.objectStore(name);
    for (const rec of changes[name]) os.put(rec);
  }
  await txDone(tx);
}

/** Scrive un singolo record. */
export function put(store, rec) {
  return putMany({ [store]: [rec] });
}

/** Svuota gli archivi indicati (di default tutti). */
export async function clear(names = STORES) {
  const db = await open();
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) tx.objectStore(name).clear();
  await txDone(tx);
}
