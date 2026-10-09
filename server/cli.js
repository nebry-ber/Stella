/**
 * server/cli.js — Comandi di amministrazione dal terminale del server.
 *
 * Con Docker:  docker compose exec app node server/cli.js <comando>
 *
 *   create-admin              crea il tuo account di amministratore (pannello di gestione)
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
import { openDb, backup } from './db.js';
import * as A from './auth.js';
import { createHotel } from './admin.js';

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
  // Con --password (test e script) la password è definitiva; altrimenti è provvisoria
  createHotel(db, { name, code, managerName, managerEmail: email, password, fields: { mustChange: !f.password } });
  console.log(`
✓ Struttura creata: ${name}
  Codice per i dipendenti: ${code}

  Accesso del manager
  Email:    ${email}
  Password: ${password}

  ${f.password ? '' : 'Password provvisoria: al primo accesso verrà chiesto di cambiarla.'}
`);
}

async function createAdmin(f) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const name = f.name || await ask(rl, 'Il tuo nome', '', (v) => (v ? null : 'obbligatorio'));
  const email = (f.email || await ask(rl, 'La tua email (per accedere al pannello)', '', (v) => (!isEmail(v) ? 'email non valida'
    : db.prepare('SELECT 1 FROM users WHERE email = ?').get(v.toLowerCase()) ? 'email già usata' : null))).toLowerCase();
  rl.close();
  const password = f.password || A.generatePassword();
  const now = Date.now();
  db.prepare("INSERT INTO users (id, hotel_id, role, name, email, pass_hash, perms, active, must_change, created_at, updated_at) VALUES (?, NULL, 'admin', ?, ?, ?, '{}', 1, ?, ?, ?)")
    .run(A.newId(), name, email, A.hashSecret(password), f.password ? 0 : 1, now, now);
  console.log(`
✓ Amministratore creato
  Email:    ${email}
  Password: ${password}   (provvisoria: al primo accesso ti verrà chiesto di cambiarla)

  Accedi dall'app, scheda "Responsabile".
`);
}

switch (cmd) {
  case 'create-admin':
    await createAdmin(flags(rest));
    break;
  case 'has-admin':
    process.exitCode = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get().n > 0 ? 0 : 1;
    break;
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
    db.prepare('UPDATE users SET pass_hash = ?, must_change = 1, updated_at = ? WHERE id = ?').run(A.hashSecret(password), Date.now(), row.id);
    A.deleteUserSessions(db, row.id);
    A.clearFailures(db, `pwd:${email}`);
    console.log(`Nuova password per ${email}: ${password}`);
    break;
  }
  case 'list': {
    for (const a of db.prepare("SELECT name, email FROM users WHERE role = 'admin'").all()) console.log(`Amministratore: ${a.name} <${a.email}>`);
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
    console.log('Comandi: create-admin | init | add-hotel | reset-password <email> | list | backup [cartella]');
}
