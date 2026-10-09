/**
 * server/cli.js — Comandi di amministrazione dal terminale del server.
 *
 * Con Docker:  docker compose exec app node server/cli.js <comando>
 *
 *   init                      prima configurazione: crea struttura e manager (domande guidate)
 *   add-hotel                 aggiunge un'altra struttura con il suo manager (domande guidate)
 *   reset-password <email>    genera una nuova password per un manager
 *   list                      elenca strutture e utenti
 *   backup [cartella]         copia del database (predefinito: DATA_DIR/backups), tiene gli ultimi 30
 *
 * Opzioni non interattive (per script e test):
 *   init --hotel-name "…" --code bucaneve --manager-name "…" --email … [--password …]
 */

import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { openDb, tx, backup } from './db.js';
import * as A from './auth.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const db = openDb(DATA_DIR);
const [cmd, ...rest] = process.argv.slice(2);

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) out[args[i].slice(2)] = args[i + 1], i++;
  return out;
}

async function ask(rl, label, def = '', check = () => null) {
  for (;;) {
    const v = (await rl.question(`${label}${def ? ` [${def}]` : ''}: `)).trim() || def;
    const err = check(v);
    if (!err) return v;
    console.log(`  ✗ ${err}`);
  }
}

const slug = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

async function hotelWizard(f) {
  let rl = null;
  const get = async (key, label, def, check) => {
    if (f[key] !== undefined) { const err = check?.(f[key]); if (err) throw new Error(`${key}: ${err}`); return f[key]; }
    rl ||= readline.createInterface({ input: process.stdin, output: process.stdout });
    return ask(rl, label, def, check);
  };
  const name = await get('hotel-name', 'Nome della struttura (es. Albergo Bucaneve)', '', (v) => (v ? null : 'obbligatorio'));
  const code = await get('code', 'Codice struttura per l\'accesso dei dipendenti (lettere minuscole)', slug(name).replace(/^(hotel|albergo)-/, ''),
    (v) => (!/^[a-z0-9-]{2,40}$/.test(v) ? 'solo lettere minuscole, numeri e trattini (2-40)'
      : db.prepare('SELECT 1 FROM hotels WHERE code = ?').get(v) ? 'codice già usato' : null));
  const managerName = await get('manager-name', 'Nome del manager', '', (v) => (v ? null : 'obbligatorio'));
  const email = (await get('email', 'Email del manager (per accedere)', '', (v) => (!isEmail(v) ? 'email non valida'
    : db.prepare('SELECT 1 FROM users WHERE email = ?').get(v.toLowerCase()) ? 'email già usata' : null))).toLowerCase();
  rl?.close();
  const password = f.password || A.generatePassword();
  const now = Date.now();
  const hotelId = A.newId();
  tx(db, () => {
    db.prepare('INSERT INTO hotels (id, code, name, active, created_at) VALUES (?, ?, ?, 1, ?)').run(hotelId, code, name, now);
    db.prepare("INSERT INTO users (id, hotel_id, role, name, email, pass_hash, perms, active, created_at, updated_at) VALUES (?, ?, 'manager', ?, ?, ?, '{}', 1, ?, ?)")
      .run(A.newId(), hotelId, managerName, email, A.hashSecret(password), now, now);
  });
  console.log(`
✓ Struttura creata: ${name}
  Codice per i dipendenti: ${code}

  Accesso del manager
  Email:    ${email}
  Password: ${password}

  Annota la password e cambiala dopo il primo accesso (Impostazioni → Il mio account).
`);
}

switch (cmd) {
  case 'init': {
    if (db.prepare('SELECT COUNT(*) n FROM hotels').get().n > 0 && !rest.includes('--force')) {
      console.log('Il server è già configurato. Per aggiungere una struttura usa: add-hotel');
      break;
    }
    await hotelWizard(flags(rest));
    break;
  }
  case 'add-hotel':
    await hotelWizard(flags(rest));
    break;
  case 'reset-password': {
    const email = String(rest[0] || '').toLowerCase();
    const row = db.prepare("SELECT id FROM users WHERE email = ? AND role IN ('manager', 'admin')").get(email);
    if (!row) { console.error('Utente non trovato.'); process.exitCode = 1; break; }
    const password = A.generatePassword();
    db.prepare('UPDATE users SET pass_hash = ?, updated_at = ? WHERE id = ?').run(A.hashSecret(password), Date.now(), row.id);
    A.deleteUserSessions(db, row.id);
    A.clearFailures(db, `pwd:${email}`);
    console.log(`Nuova password per ${email}: ${password}`);
    break;
  }
  case 'list': {
    for (const h of db.prepare('SELECT * FROM hotels ORDER BY name').all()) {
      console.log(`\n${h.name}  (codice: ${h.code}${h.active ? '' : ', disattivata'})`);
      for (const u of db.prepare('SELECT role, name, email, active FROM users WHERE hotel_id = ? ORDER BY role, name').all(h.id)) {
        console.log(`  ${u.role.padEnd(8)} ${u.name}${u.email ? ` <${u.email}>` : ''}${u.active ? '' : ' (disattivato)'}`);
      }
    }
    break;
  }
  case 'backup': {
    const dir = rest[0] || path.join(DATA_DIR, 'backups');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    const file = path.join(dir, `stella-${stamp}.db`);
    backup(db, file);
    const old = fs.readdirSync(dir).filter((f) => /^stella-.*\.db$/.test(f)).sort().slice(0, -30);
    for (const f of old) fs.unlinkSync(path.join(dir, f));
    console.log(`Backup salvato: ${file}`);
    break;
  }
  default:
    console.log('Comandi: init | add-hotel | reset-password <email> | list | backup [cartella]');
}
