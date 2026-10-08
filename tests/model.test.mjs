// Test della logica pura. Eseguire dalla cartella del progetto con:  node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';

const line = (o) => ({ id: M.uuid(), qty: 1, price: 100, vat: 10, cancelled: false, createdAt: 0, ...o });

test('parseEuro accetta virgola e punto', () => {
  assert.equal(M.parseEuro('3,50'), 350);
  assert.equal(M.parseEuro('3.5'), 350);
  assert.equal(M.parseEuro(' 12 '), 1200);
  assert.ok(Number.isNaN(M.parseEuro('abc')));
  assert.ok(Number.isNaN(M.parseEuro('1,234')));
});

test('totali e scorporo IVA, righe annullate escluse', () => {
  const t = M.computeTotals([
    line({ price: 150, qty: 2, vat: 10 }),       // 3,00
    line({ price: 1000, qty: 1, vat: 22 }),      // 10,00
    line({ price: 500, qty: 1, vat: 10, cancelled: true }),
  ]);
  assert.equal(t.total, 1300);
  assert.deepEqual(t.vat, [
    { rate: 22, gross: 1000, net: 820, tax: 180 },
    { rate: 10, gross: 300, net: 273, tax: 27 },
  ]);
  for (const v of t.vat) assert.equal(v.net + v.tax, v.gross);
});

test('mergeRecords: aggiunge, aggiorna il più recente, ignora i vecchi', () => {
  const local = [{ id: 'a', updatedAt: 10, device: 'A' }, { id: 'b', updatedAt: 50, device: 'A' }];
  const incoming = [
    { id: 'a', updatedAt: 20, device: 'B' }, // più recente → aggiorna
    { id: 'b', updatedAt: 40, device: 'B' }, // più vecchio → ignora
    { id: 'c', updatedAt: 5, device: 'B' },  // nuovo → aggiunge
    { nope: true },                          // non valido → ignora
  ];
  const r = M.mergeRecords(local, incoming);
  assert.deepEqual(r.added.map((x) => x.id), ['c']);
  assert.deepEqual(r.updated.map((x) => x.id), ['a']);
  assert.equal(r.skipped, 2);
  // Importare di nuovo lo stesso file non cambia nulla
  const again = M.mergeRecords([...local.filter((x) => x.id === 'b'), ...r.toWrite], incoming);
  assert.equal(again.toWrite.length, 0);
});

test('isNewer: a parità di orario decide il dispositivo, in modo simmetrico', () => {
  const a = { updatedAt: 7, device: 'BAR' };
  const b = { updatedAt: 7, device: 'RECEPTION' };
  assert.notEqual(M.isNewer(a, b), M.isNewer(b, a));
});

test('stamp: updatedAt cresce sempre', () => {
  const r = M.stamp({ updatedAt: 5000 }, 'X', 1000);
  assert.equal(r.updatedAt, 5001);
  assert.equal(r.device, 'X');
});

test('nome file di esportazione', () => {
  const ts = new Date(2026, 9, 8, 10, 30).getTime();
  assert.equal(M.exportFileName('Bar Hall', ts), 'bucaneve_Bar-Hall_2026-10-08_1030.json');
  assert.equal(M.exportFileName('Réception', ts), 'bucaneve_Reception_2026-10-08_1030.json');
});

test('CSV: punto e virgola, virgola decimale, BOM, escape', () => {
  const ts = new Date(2026, 9, 8, 9, 5).getTime();
  const acc = { id: 'x', locationName: 'Camera 5', guestName: 'Rossi; Mario', closedAt: ts };
  const csv = M.buildCsv([acc], [
    line({ accountId: 'x', name: 'Caffè', price: 150, qty: 2, createdAt: ts, device: 'BAR' }),
    line({ accountId: 'x', name: 'Annullata', cancelled: true, createdAt: ts }),
  ]);
  assert.ok(csv.startsWith('﻿'));
  const rows = csv.slice(1).trim().split('\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].split(';')[0], 'Data');
  assert.equal(rows[1], '08/10/2026;09:05;Camera 5;"Rossi; Mario";Caffè;2;1,50;10;3,00;08/10/2026;BAR');
});

test('validateExport rifiuta file estranei', () => {
  assert.throws(() => M.validateExport({ foo: 1 }));
  assert.throws(() => M.validateExport({ app: 'bucaneve', version: 99, data: {} }));
  assert.ok(M.validateExport({ app: 'bucaneve', version: 1, data: { consumptions: [] } }));
});

test('dati iniziali: 30 camere, 10 extra, id stabili', () => {
  const l = M.defaultLocations();
  assert.equal(l.filter((x) => x.kind === 'camera').length, 30);
  assert.equal(l.filter((x) => x.kind === 'extra').length, 10);
  assert.equal(new Set(M.defaultProducts().map((p) => p.id)).size, M.defaultProducts().length);
});

test('voci di soggiorno: descrizione, IVA fuori campo, tariffe con id fissi', () => {
  assert.equal(M.stayLineName('room', 3), 'Conto camera · 3 notti');
  assert.equal(M.stayLineName('pet', 1), 'Supplemento animale domestico · 1 notte');
  assert.equal(M.stayLineName('tax', 2, 3), 'Tassa di soggiorno · 3 persone × 2 notti');
  assert.equal(M.vatLabel(0), 'Esente / fuori campo IVA');
  assert.equal(M.vatLabel(10), '10%');
  const ids = M.defaultStayProducts().map((p) => p.id);
  assert.deepEqual(ids, ['stay-room', 'stay-pet', 'stay-tax']);
  assert.ok(M.defaultStayProducts().every((p) => p.category === M.STAY_CATEGORY));
});

test('riepilogo testuale per email: soggiorno prima, annullate escluse, totali IVA', () => {
  const ts = new Date(2026, 9, 8, 9, 5).getTime();
  const lines = [
    line({ name: 'Caffè', price: 150, qty: 2, createdAt: ts }),
    line({ name: 'Conto camera · 2 notti', category: 'soggiorno', price: 10000, qty: 2, createdAt: ts + 1 }),
    line({ name: 'Tassa di soggiorno · 2 persone × 2 notti', category: 'soggiorno', price: 150, qty: 4, vat: 0, createdAt: ts + 2 }),
    line({ name: 'Spritz', price: 600, cancelled: true, createdAt: ts }),
  ];
  const t = M.buildTextSummary({ hotel: 'Hotel Bucaneve', name: 'Camera 5', guestName: 'Rossi', lines, closedAt: ts });
  assert.ok(t.indexOf('SOGGIORNO') < t.indexOf('CONSUMAZIONI'));
  assert.ok(t.includes('- Conto camera · 2 notti: 2 × 100,00 € = 200,00 €'));
  assert.ok(t.includes('- Esente / fuori campo IVA: 6,00 €'));
  assert.ok(t.includes('TOTALE: 209,00 €'));
  assert.ok(!t.includes('Spritz'));
  assert.ok(!/[  ]/.test(t));
});

test('mailto: destinatario, oggetto e a capo codificati', () => {
  const h = M.mailtoHref('ospite@esempio.it', 'Riepilogo Camera 5', 'riga 1\nriga 2 & più');
  assert.equal(h, 'mailto:ospite@esempio.it?subject=Riepilogo%20Camera%205&body=riga%201%0D%0Ariga%202%20%26%20pi%C3%B9');
  assert.ok(M.isEmail('a.b@c.it'));
  assert.ok(!M.isEmail('a@b'));
});
