// Test del server: accessi, permessi, sincronizzazione. Eseguire con:  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import * as A from '../server/auth.js';

let server;
let base;
let hotelId;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stella-test-'));

before(async () => {
  server = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const db = server.db;
  hotelId = A.newId();
  const now = Date.now();
  db.prepare("INSERT INTO hotels (id, code, name, active, created_at) VALUES (?, 'bucaneve', 'Albergo Bucaneve', 1, ?)").run(hotelId, now);
  db.prepare("INSERT INTO users (id, hotel_id, role, name, email, pass_hash, perms, active, created_at, updated_at) VALUES (?, ?, 'manager', 'Mario', 'mario@test.it', ?, '{}', 1, ?, ?)")
    .run(A.newId(), hotelId, A.hashSecret('password-giusta'), now, now);
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** Piccolo client con cookie, come un browser. */
function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

const line = (o) => ({ id: A.newId(), locationId: 'R5', accountId: null, productId: 'p001', name: 'Caffè', price: 150, vat: 10, qty: 1, cancelled: false, createdAt: Date.now(), updatedAt: Date.now(), device: 'X', ...o });

let manager;
let staffId;

test('login manager: password sbagliata rifiutata, giusta accettata', async () => {
  manager = client();
  assert.equal((await manager('POST', '/api/login', { email: 'mario@test.it', password: 'no' })).status, 401);
  const ok = await manager('POST', '/api/login', { email: 'MARIO@test.it', password: 'password-giusta' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'manager');
  assert.equal((await manager('GET', '/api/me')).body.user.hotel.code, 'bucaneve');
});

test('blocco dopo 5 tentativi sbagliati', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c('POST', '/api/login', { email: 'nessuno@test.it', password: 'x' });
  const r = await c('POST', '/api/login', { email: 'nessuno@test.it', password: 'x' });
  assert.equal(r.status, 429);
});

test('manager crea un dipendente; nomi doppi e PIN corti rifiutati', async () => {
  assert.equal((await manager('POST', '/api/staff', { name: 'Anna', pin: '12' })).status, 400);
  const r = await manager('POST', '/api/staff', { name: 'Anna', pin: '4321', perms: { closeAccounts: false } });
  assert.equal(r.status, 200);
  staffId = r.body.staff.id;
  assert.equal(r.body.staff.perms.closeAccounts, false);
  assert.equal((await manager('POST', '/api/staff', { name: 'anna', pin: '1111' })).status, 409);
});

test('accesso dipendente con codice struttura e PIN', async () => {
  const pub = client();
  const list = await pub('GET', '/api/hotel/bucaneve/staff');
  assert.deepEqual(list.body.staff.map((s) => s.name), ['Anna']);
  assert.equal((await pub('GET', '/api/hotel/inesistente/staff')).status, 404);
  assert.equal((await pub('POST', '/api/login-pin', { code: 'bucaneve', userId: staffId, pin: '0000' })).status, 401);
  const ok = await pub('POST', '/api/login-pin', { code: 'bucaneve', userId: staffId, pin: '4321' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'staff');
});

test('sincronizzazione: ciò che scrive un dispositivo arriva all\'altro', async () => {
  const anna = client();
  await anna('POST', '/api/login-pin', { code: 'bucaneve', userId: staffId, pin: '4321' });
  const l = line({ device: 'Anna' });
  const push = await anna('POST', '/api/sync', { cursor: 0, changes: { consumptions: [l] } });
  assert.equal(push.body.written, 1);
  const pull = await manager('POST', '/api/sync', { cursor: 0, changes: {} });
  assert.deepEqual(pull.body.changes.consumptions.map((c) => c.id), [l.id]);
  // Il cursore evita di riscaricare
  const again = await manager('POST', '/api/sync', { cursor: pull.body.cursor, changes: {} });
  assert.equal(again.body.changes.consumptions, undefined);
});

test('vince la modifica più recente; la versione vecchia riceve quella del server', async () => {
  const l = line({ updatedAt: 1000, device: 'A' });
  await manager('POST', '/api/sync', { cursor: 0, changes: { consumptions: [{ ...l, qty: 3, updatedAt: 2000 }] } });
  const old = await manager('POST', '/api/sync', { cursor: 999999, changes: { consumptions: [{ ...l, qty: 1, updatedAt: 1500 }] } });
  assert.equal(old.body.written, 0);
  assert.equal(old.body.changes.consumptions[0].qty, 3);
});

test('permessi: dipendente senza "chiudere i conti" e senza listino viene respinto', async () => {
  const anna = client();
  await anna('POST', '/api/login-pin', { code: 'bucaneve', userId: staffId, pin: '4321' });
  const l = line();
  await anna('POST', '/api/sync', { cursor: 0, changes: { consumptions: [l] } });
  const r = await anna('POST', '/api/sync', {
    cursor: 0,
    changes: {
      accounts: [{ id: A.newId(), locationId: 'R5', total: 150, closedAt: Date.now(), updatedAt: Date.now() + 5 }],
      consumptions: [{ ...l, accountId: 'x', updatedAt: Date.now() + 5 }],
      products: [{ id: 'p001', name: 'Caffè', price: 1, category: 'caffetteria', vat: 10, updatedAt: Date.now() + 5 }],
    },
  });
  assert.deepEqual(r.body.rejected.map((x) => x.store).sort(), ['accounts', 'consumptions', 'products']);
  assert.equal(r.body.written, 0);
  // Il nome ospite invece si può cambiare
  await manager('POST', '/api/sync', { cursor: 0, changes: { locations: [{ id: 'R5', kind: 'camera', label: '5', order: 5, active: true, guestName: '', updatedAt: 10, device: 'Mario' }] } });
  const g = await anna('POST', '/api/sync', { cursor: 0, changes: { locations: [{ id: 'R5', kind: 'camera', label: '5', order: 5, active: true, guestName: 'Rossi', updatedAt: 20, device: 'Anna' }] } });
  assert.equal(g.body.written, 1);
  const lbl = await anna('POST', '/api/sync', { cursor: 0, changes: { locations: [{ id: 'R5', kind: 'camera', label: '105', order: 5, active: true, guestName: 'Rossi', updatedAt: 30, device: 'Anna' }] } });
  assert.equal(lbl.body.rejected.length, 1);
});

test('PIN cambiato o dipendente disattivato: la sessione decade', async () => {
  const anna = client();
  await anna('POST', '/api/login-pin', { code: 'bucaneve', userId: staffId, pin: '4321' });
  assert.equal((await anna('GET', '/api/me')).status, 200);
  await manager('PATCH', `/api/staff/${staffId}`, { active: false });
  assert.equal((await anna('GET', '/api/me')).status, 401);
  assert.equal((await anna('POST', '/api/login-pin', { code: 'bucaneve', userId: staffId, pin: '4321' })).status, 401);
});

test('sicurezza: origine estranea, non-JSON, file interni', async () => {
  assert.equal((await manager('POST', '/api/sync', {}, { origin: 'https://sito-estraneo.example' })).status, 403);
  const form = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(form.status, 415);
  for (const p of ['/server/db.js', '/data/stella.db', '/.git/config', '/package.json', '/js/../server/auth.js']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
});

test('amministratore: crea struttura, credenziali provvisorie, cambio obbligatorio, logo, disattivazione', async () => {
  const now = Date.now();
  server.db.prepare("INSERT INTO users (id, hotel_id, role, name, email, pass_hash, perms, active, created_at, updated_at) VALUES (?, NULL, 'admin', 'Admin', 'admin@test.it', ?, '{}', 1, ?, ?)")
    .run(A.newId(), A.hashSecret('admin-password'), now, now);
  const admin = client();
  assert.equal((await admin('POST', '/api/login', { email: 'admin@test.it', password: 'admin-password' })).body.user.role, 'admin');
  // Un manager non può usare il pannello
  assert.equal((await manager('GET', '/api/admin/hotels')).status, 403);

  const created = await admin('POST', '/api/admin/hotels', {
    name: 'Hotel Larice', code: 'larice', managerName: 'Paolo', managerEmail: 'paolo@larice.test', subEnd: '2027-10-31', priceCents: 29900, plan: 'Annuale',
  });
  assert.equal(created.status, 200);
  const { password } = created.body.credentials;
  assert.equal(created.body.hotel.status, 'attivo');
  assert.equal((await admin('POST', '/api/admin/hotels', { name: 'X', code: 'larice', managerName: 'Y', managerEmail: 'y@y.it' })).status, 409);

  // Il manager entra con la password provvisoria: può solo cambiarla
  const paolo = client();
  const login = await paolo('POST', '/api/login', { email: 'paolo@larice.test', password });
  assert.equal(login.body.user.mustChange, true);
  assert.equal((await paolo('POST', '/api/sync', { cursor: 0, changes: {} })).status, 403);
  assert.equal((await paolo('POST', '/api/password', { current: password, next: password })).status, 400);
  assert.equal((await paolo('POST', '/api/password', { current: password, next: 'nuova-password-paolo' })).status, 200);
  const sync = await paolo('POST', '/api/sync', { cursor: 0, changes: {} });
  assert.equal(sync.status, 200);
  // L'intestazione della ricevuta ha già il nome della nuova struttura
  assert.equal(sync.body.changes.config[0].name, 'Hotel Larice');

  // Logo caricato dall'amministratore → arriva ai dispositivi della struttura
  const hid = created.body.hotel.id;
  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  assert.equal((await admin('POST', `/api/admin/hotels/${hid}/logo`, { logo: 'javascript:alert(1)' })).status, 400);
  assert.equal((await admin('POST', `/api/admin/hotels/${hid}/logo`, { logo })).status, 200);
  const after = await paolo('POST', '/api/sync', { cursor: sync.body.cursor, changes: {} });
  assert.equal(after.body.changes.config[0].logo, logo);

  // Nuova password provvisoria: la vecchia smette di funzionare
  const mid = created.body.hotel.managers[0].id;
  const reset = await admin('POST', `/api/admin/users/${mid}/reset`, {});
  assert.equal((await paolo('GET', '/api/me')).status, 401);
  assert.equal((await client()('POST', '/api/login', { email: 'paolo@larice.test', password: reset.body.credentials.password })).body.user.mustChange, true);

  // Abbonamento scaduto e struttura disattivata
  const exp = await admin('PATCH', `/api/admin/hotels/${hid}`, { subEnd: '2020-01-01' });
  assert.equal(exp.body.hotel.status, 'scaduto');
  const p2 = client();
  await p2('POST', '/api/login', { email: 'paolo@larice.test', password: reset.body.credentials.password });
  await admin('PATCH', `/api/admin/hotels/${hid}`, { active: false });
  assert.equal((await p2('GET', '/api/me')).status, 401);
  assert.equal((await p2('POST', '/api/login', { email: 'paolo@larice.test', password: reset.body.credentials.password })).status, 403);
  const list = await admin('GET', '/api/admin/hotels');
  assert.deepEqual(list.body.hotels.map((h) => [h.code, h.status]).sort(), [['bucaneve', 'senza-scadenza'], ['larice', 'disattivata']]);
});

test('amministratori: nuovo amministratore con password provvisoria, reset di altri ma non di sé', async () => {
  const admin = client();
  await admin('POST', '/api/login', { email: 'admin@test.it', password: 'admin-password' });
  const me = (await admin('GET', '/api/me')).body.user;
  assert.equal((await admin('POST', `/api/admin/users/${me.id}/reset`, {})).status, 400);
  const created = await admin('POST', '/api/admin/admins', { name: 'Socio', email: 'socio@test.it' });
  assert.equal(created.status, 200);
  const socio = client();
  assert.equal((await socio('POST', '/api/login', { email: 'socio@test.it', password: created.body.credentials.password })).body.user.mustChange, true);
  assert.equal((await socio('GET', '/api/admin/hotels')).status, 403); // prima deve cambiare la password
  const list = await admin('GET', '/api/admin/admins');
  const sid = list.body.admins.find((a) => a.email === 'socio@test.it').id;
  const reset = await admin('POST', `/api/admin/users/${sid}/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal((await socio('GET', '/api/me')).status, 401);
});
