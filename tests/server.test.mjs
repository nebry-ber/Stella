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
