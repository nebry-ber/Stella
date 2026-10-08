/**
 * model.js — Regole di dominio pure (nessun accesso a DOM o database).
 *
 * Qui stanno calcoli dei totali, IVA, unione dei dati importati, CSV,
 * formattazione. Essendo funzioni pure si possono testare con Node
 * (vedi tests/model.test.mjs) e riusare con qualsiasi tipo di archivio.
 *
 * Convenzione: tutti gli importi sono in CENTESIMI (numeri interi) per
 * evitare errori di arrotondamento. I prezzi del listino sono IVA inclusa.
 */

export const APP_ID = 'bucaneve';
export const EXPORT_VERSION = 1;

export const CATEGORIES = [
  { id: 'caffetteria', label: 'Caffetteria' },
  { id: 'bevande', label: 'Bevande' },
  { id: 'alcolici', label: 'Alcolici' },
  { id: 'cucina', label: 'Cucina' },
  { id: 'altro', label: 'Altro' },
];

export const VAT_RATES = [22, 10, 5, 4, 0];

/**
 * Voci di soggiorno aggiunte al check-out. Sono prodotti speciali (categoria
 * "soggiorno", id fissi) salvati nel listino: così le tariffe si modificano
 * nelle impostazioni e si sincronizzano tra i dispositivi. Non compaiono tra
 * i pulsanti dell'aggiunta rapida.
 */
export const STAY_CATEGORY = 'soggiorno';
export const STAY_TYPES = {
  room: { id: 'stay-room', name: 'Conto camera', unit: 'a notte' },
  pet: { id: 'stay-pet', name: 'Supplemento animale domestico', unit: 'a notte' },
  tax: { id: 'stay-tax', name: 'Tassa di soggiorno', unit: 'a persona a notte' },
};

/** Tariffe iniziali (indicative, da verificare): la camera si inserisce al check-out. */
export function defaultStayProducts() {
  return [
    { ...stayBase('room'), price: 0, vat: 10, order: 1001 },
    { ...stayBase('pet'), price: 1000, vat: 10, order: 1002 },
    // L'imposta di soggiorno è fuori campo IVA: aliquota 0
    { ...stayBase('tax'), price: 150, vat: 0, order: 1003 },
  ];
}
function stayBase(type) {
  const t = STAY_TYPES[type];
  return { id: t.id, name: t.name, category: STAY_CATEGORY, stay: type, active: true, updatedAt: 0, device: 'iniziale' };
}

export function isStayLine(line) {
  return line.category === STAY_CATEGORY;
}

/** Descrizione della riga di soggiorno, es. "Tassa di soggiorno · 2 persone × 3 notti". */
export function stayLineName(type, nights, persons = 1) {
  const n = nights === 1 ? '1 notte' : `${nights} notti`;
  if (type === 'tax') return `${STAY_TYPES.tax.name} · ${persons === 1 ? '1 persona' : `${persons} persone`} × ${n}`;
  return `${STAY_TYPES[type].name} · ${n}`;
}

/** Etichetta dell'aliquota nel riepilogo (lo 0% è la tassa di soggiorno o voci esenti). */
export function vatLabel(rate) {
  return rate === 0 ? 'Esente / fuori campo IVA' : `${rate}%`;
}

/** Finestra entro cui un secondo tocco sullo stesso prodotto aumenta la quantità. */
export const MERGE_WINDOW_MS = 15 * 60 * 1000;

/** Avviso se l'ultima esportazione è più vecchia di così. */
export const EXPORT_WARNING_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Identificativi e marcatura delle modifiche
// ---------------------------------------------------------------------------

export function uuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Ripiego per browser vecchi o contesti non sicuri (http su rete locale).
  const b = new Uint8Array(16);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Restituisce una copia del record con updatedAt e device aggiornati.
 * updatedAt cresce sempre rispetto al valore precedente, anche se l'orologio
 * del dispositivo fosse indietro: così una modifica locale non "perde" mai
 * contro la versione che sta sostituendo.
 */
export function stamp(rec, device, now = Date.now()) {
  return { ...rec, updatedAt: Math.max(now, (rec.updatedAt || 0) + 1), device };
}

// ---------------------------------------------------------------------------
// Importi e IVA
// ---------------------------------------------------------------------------

const euroFmt = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const numFmt = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

/** 1250 → "12,50 €" */
export function formatEuro(cents) {
  return euroFmt.format((cents || 0) / 100);
}

/** 1250 → "12,50" (senza simbolo e senza separatore migliaia: per CSV/Excel) */
export function formatDecimal(cents) {
  return numFmt.format((cents || 0) / 100);
}

/** "3,50" / "3.5" / "3" → 350. Restituisce NaN se non valido. */
export function parseEuro(text) {
  const s = String(text ?? '').trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

export function lineTotal(line) {
  return line.price * line.qty;
}

/** Righe che concorrono al totale (le annullate restano visibili ma non contano). */
export function activeLines(lines) {
  return lines.filter((l) => !l.cancelled);
}

/**
 * Totale e ripartizione per aliquota IVA.
 * Il prezzo è IVA inclusa: imponibile = lordo / (1 + aliquota).
 * Lo scorporo si fa sul totale di ogni aliquota (non riga per riga).
 */
export function computeTotals(lines) {
  const byRate = new Map();
  let total = 0;
  for (const l of activeLines(lines)) {
    const t = lineTotal(l);
    total += t;
    byRate.set(l.vat, (byRate.get(l.vat) || 0) + t);
  }
  const vat = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, gross]) => {
      const net = Math.round((gross * 100) / (100 + rate));
      return { rate, gross, net, tax: gross - net };
    });
  return { total, vat };
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** Data locale "AAAA-MM-GG" (formato degli input type=date). */
export function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "08/10/2026" */
export function formatDate(ts) {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** "10:30" */
export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(ts) {
  return `${formatDate(ts)} ${formatTime(ts)}`;
}

/** Inizio (00:00) e fine (23:59:59.999) di una data "AAAA-MM-GG" in ora locale. */
export function dayRange(fromKey, toKey) {
  const [fy, fm, fd] = fromKey.split('-').map(Number);
  const [ty, tm, td] = toKey.split('-').map(Number);
  return {
    from: new Date(fy, fm - 1, fd, 0, 0, 0, 0).getTime(),
    to: new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime(),
  };
}

/** Descrizione leggibile del tempo trascorso: "3 ore fa", "2 giorni fa". */
export function timeAgo(ts, now = Date.now()) {
  const min = Math.round((now - ts) / 60000);
  if (min < 1) return 'pochi secondi fa';
  if (min < 60) return min === 1 ? '1 minuto fa' : `${min} minuti fa`;
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? '1 ora fa' : `${h} ore fa`;
  const g = Math.floor(h / 24);
  return g === 1 ? '1 giorno fa' : `${g} giorni fa`;
}

// ---------------------------------------------------------------------------
// Postazioni (camere ed extra)
// ---------------------------------------------------------------------------

/** Nome completo da mostrare: "Camera 12" oppure l'etichetta della postazione extra. */
export function locationName(loc) {
  if (!loc) return '—';
  return loc.kind === 'camera' ? `Camera ${loc.label}` : loc.label;
}

/**
 * Postazioni iniziali. Gli id sono fissi (R1…R30, E1…E10) così due dispositivi
 * inizializzati separatamente condividono gli stessi id e la sincronizzazione
 * non crea doppioni. updatedAt = 0: qualsiasi modifica reale ha la precedenza.
 */
export function defaultLocations() {
  const list = [];
  for (let i = 1; i <= 30; i++) {
    list.push({ id: `R${i}`, kind: 'camera', label: String(i), order: i, active: true, guestName: '', updatedAt: 0, device: 'iniziale' });
  }
  for (let i = 1; i <= 10; i++) {
    list.push({ id: `E${i}`, kind: 'extra', label: `E${i}`, order: 100 + i, active: true, guestName: '', updatedAt: 0, device: 'iniziale' });
  }
  return list;
}

/** Listino di esempio da bar d'albergo (prezzi IVA inclusa, aliquote indicative). */
export function defaultProducts() {
  const rows = [
    ['caffetteria', 'Caffè espresso', 150, 10],
    ['caffetteria', 'Caffè decaffeinato', 160, 10],
    ['caffetteria', 'Caffè macchiato', 160, 10],
    ['caffetteria', 'Cappuccino', 200, 10],
    ['caffetteria', 'Caffè d\'orzo', 180, 10],
    ['caffetteria', 'Tè / infuso', 250, 10],
    ['caffetteria', 'Cioccolata calda', 350, 10],
    ['caffetteria', 'Brioche', 150, 10],
    ['bevande', 'Acqua naturale 0,5 l', 150, 10],
    ['bevande', 'Acqua frizzante 0,5 l', 150, 10],
    ['bevande', 'Bibita in lattina', 300, 10],
    ['bevande', 'Succo di frutta', 300, 10],
    ['bevande', 'Spremuta d\'arancia', 400, 10],
    ['bevande', 'Tè freddo', 300, 10],
    ['alcolici', 'Birra piccola', 350, 10],
    ['alcolici', 'Birra media', 500, 10],
    ['alcolici', 'Calice vino rosso', 500, 10],
    ['alcolici', 'Calice vino bianco', 500, 10],
    ['alcolici', 'Calice Trentodoc', 600, 10],
    ['alcolici', 'Spritz', 600, 10],
    ['alcolici', 'Grappa trentina', 400, 10],
    ['alcolici', 'Amaro', 400, 10],
    ['alcolici', 'Bombardino', 500, 10],
    ['alcolici', 'Vin brulé', 400, 10],
    ['cucina', 'Toast', 450, 10],
    ['cucina', 'Tramezzino', 350, 10],
    ['cucina', 'Panino speck e formaggio', 600, 10],
    ['cucina', 'Tagliere salumi e formaggi', 1400, 10],
    ['cucina', 'Strudel di mele', 500, 10],
    ['cucina', 'Patatine', 200, 10],
    ['altro', 'Cartolina', 100, 22],
    ['altro', 'Crema solare', 900, 22],
    ['altro', 'Noleggio ciaspole (giorno)', 1000, 22],
  ];
  return rows.map(([category, name, price, vat], i) => ({
    id: `p${String(i + 1).padStart(3, '0')}`,
    name, price, vat, category,
    order: i + 1, active: true, updatedAt: 0, device: 'iniziale',
  }));
}

// ---------------------------------------------------------------------------
// Sincronizzazione: unione dei dati
// ---------------------------------------------------------------------------

/**
 * true se "incoming" deve sostituire "local".
 * Vince la modifica più recente (updatedAt). A parità, per avere lo stesso
 * risultato su tutti i dispositivi, decide l'ordine alfabetico del dispositivo.
 */
export function isNewer(incoming, local) {
  if (!local) return true;
  const a = incoming.updatedAt || 0;
  const b = local.updatedAt || 0;
  if (a !== b) return a > b;
  return String(incoming.device || '') > String(local.device || '');
}

/**
 * Confronta i record importati con quelli locali.
 * @returns {{ toWrite: object[], added: object[], updated: object[], skipped: number }}
 */
export function mergeRecords(localList, incomingList) {
  const local = new Map(localList.map((r) => [r.id, r]));
  const out = { toWrite: [], added: [], updated: [], skipped: 0 };
  for (const rec of incomingList) {
    if (!rec || typeof rec.id !== 'string' || !rec.id) { out.skipped++; continue; }
    const cur = local.get(rec.id);
    if (!cur) { out.toWrite.push(rec); out.added.push(rec); }
    else if (isNewer(rec, cur)) { out.toWrite.push(rec); out.updated.push(rec); }
    else out.skipped++;
  }
  return out;
}

/** Controlla che un oggetto sia un'esportazione valida di questa app. */
export function validateExport(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Il file non contiene dati validi.');
  if (obj.app !== APP_ID) throw new Error('Il file non è un\'esportazione di Bucaneve.');
  if (typeof obj.version !== 'number' || obj.version > EXPORT_VERSION) {
    throw new Error('Il file è stato creato da una versione più recente dell\'app: aggiorna l\'app e riprova.');
  }
  const d = obj.data;
  if (!d || typeof d !== 'object') throw new Error('Il file non contiene la sezione dati.');
  for (const k of ['locations', 'products', 'consumptions', 'accounts']) {
    if (d[k] !== undefined && !Array.isArray(d[k])) throw new Error(`Sezione "${k}" non valida.`);
  }
  return true;
}

/** Riduce un testo a caratteri sicuri per un nome di file. */
export function slug(text) {
  const s = String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'dispositivo';
}

/** bucaneve_BAR_2026-10-08_1030.json */
export function exportFileName(deviceName, ts = Date.now()) {
  const d = new Date(ts);
  return `${APP_ID}_${slug(deviceName)}_${dateKey(ts)}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

// ---------------------------------------------------------------------------
// CSV per Excel in italiano
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = String(v ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Una riga per consumazione dei conti chiusi (le righe annullate sono escluse).
 * Separatore ";" e decimali con la virgola; BOM iniziale perché Excel
 * riconosca le lettere accentate.
 * @param {object[]} accounts conti chiusi
 * @param {object[]} lines consumazioni di quei conti
 */
export function buildCsv(accounts, lines) {
  const header = ['Data', 'Ora', 'Camera', 'Ospite', 'Prodotto', 'Quantità', 'Prezzo', 'IVA %', 'Totale', 'Data chiusura conto', 'Dispositivo'];
  const accById = new Map(accounts.map((a) => [a.id, a]));
  const rows = activeLines(lines)
    .filter((l) => accById.has(l.accountId))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((l) => {
      const a = accById.get(l.accountId);
      return [
        formatDate(l.createdAt), formatTime(l.createdAt), a.locationName, a.guestName || '',
        l.name, l.qty, formatDecimal(l.price), l.vat, formatDecimal(lineTotal(l)),
        formatDate(a.closedAt), l.device || '',
      ];
    });
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Riepilogo in testo semplice (email / condivisione)
// ---------------------------------------------------------------------------

/** Periodo coperto dalle righe: "08/10/2026" oppure "dal 05/10/2026 al 08/10/2026". */
export function periodText(lines) {
  const active = activeLines(lines);
  if (!active.length) return '—';
  const ts = active.map((l) => l.createdAt);
  const first = Math.min(...ts);
  const last = Math.max(...ts);
  return dateKey(first) === dateKey(last) ? formatDate(first) : `dal ${formatDate(first)} al ${formatDate(last)}`;
}

/**
 * Riepilogo non fiscale in testo semplice, adatto al corpo di un'email.
 * Le righe annullate non compaiono; le voci di soggiorno sono elencate per prime.
 */
export function buildTextSummary({ hotel, name, guestName, lines, closedAt }) {
  const active = activeLines(lines);
  const stay = active.filter(isStayLine);
  const items = active.filter((l) => !isStayLine(l));
  const totals = computeTotals(lines);
  const row = (l) => `- ${l.name}: ${l.qty} × ${formatEuro(l.price)} = ${formatEuro(lineTotal(l))}`;
  const out = [
    hotel,
    'RIEPILOGO NON FISCALE',
    '',
    guestName ? `${name} – ${guestName}` : name,
    `Periodo: ${periodText(lines)}`,
    `${closedAt ? 'Conto chiuso il' : 'Data'}: ${formatDateTime(closedAt || Date.now())}`,
  ];
  if (stay.length) out.push('', 'SOGGIORNO', ...stay.map(row));
  if (items.length) out.push('', 'CONSUMAZIONI', ...items.map((l) => `${row(l)} (${formatDate(l.createdAt)} ${formatTime(l.createdAt)})`));
  out.push('', 'IVA');
  for (const v of totals.vat) {
    out.push(v.rate === 0
      ? `- ${vatLabel(0)}: ${formatEuro(v.gross)}`
      : `- ${v.rate}%: imponibile ${formatEuro(v.net)}, IVA ${formatEuro(v.tax)}, totale ${formatEuro(v.gross)}`);
  }
  out.push('', `TOTALE: ${formatEuro(totals.total)}`, '', 'Documento riepilogativo non valido ai fini fiscali. Prezzi IVA inclusa.');
  // Spazi non separabili di Intl ("12,50 €") → spazi normali, più leggibili nelle app di posta
  return out.join('\n').replace(/\u00a0|\u202f/g, ' ');
}

/** Link mailto: con destinatario, oggetto e testo (a capo in formato CRLF). */
export function mailtoHref(to, subject, body) {
  const enc = (t) => encodeURIComponent(t).replace(/%0A/g, '%0D%0A');
  return `mailto:${encodeURIComponent(String(to || '').trim()).replace(/%40/g, '@')}?subject=${enc(subject)}&body=${enc(body)}`;
}

/** Controllo leggero del formato di un indirizzo email. */
export function isEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text || '').trim());
}
