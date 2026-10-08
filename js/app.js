/**
 * app.js — Interfaccia utente.
 *
 * Contiene solo presentazione e gestione degli eventi: tutti i dati passano
 * da store.js (servizio dati) e i calcoli da model.js.
 * Navigazione con l'hash dell'URL (#/, #/loc/R5, #/storico…), così funziona
 * su GitHub Pages senza configurazioni del server.
 */

import * as S from './store.js';
import * as M from './model.js';

const APP_VERSION = '1.1.0';
const UNLOCK_MS = 5 * 60 * 1000; // dopo il PIN, impostazioni sbloccate per 5 minuti

const $view = document.getElementById('view');
const $title = document.getElementById('page-title');
const $subtitle = document.getElementById('page-subtitle');
const $back = document.getElementById('btn-back');

/** Stato dell'interfaccia (non persistente). */
const ui = {
  category: 'caffetteria',
  unlockedUntil: 0,
  backTo: '#/',
  history: { from: M.dateKey(Date.now() - 6 * 864e5), to: M.dateKey(Date.now()) },
  csv: { from: M.dateKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), to: M.dateKey(Date.now()) },
  importResult: null,
  pendingToast: null, // avviso da mostrare dopo il prossimo cambio di schermata
  stay: { loc: null, nights: 1, persons: 1, prices: {} }, // campi del riquadro "Voci di soggiorno"
};

const HOTEL = 'Hotel Bucaneve – Ronzone (TN)';

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Rende sicuro un testo da inserire nell'HTML. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const euro = M.formatEuro;

function setHeader(title, subtitle = '', backTo = null) {
  $title.textContent = title;
  $subtitle.textContent = subtitle;
  ui.backTo = backTo;
  $back.hidden = !backTo;
  document.title = backTo ? `${title} · Bucaneve` : 'Bucaneve · Consumazioni';
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/** Scarica un file generato nel browser. */
function download(fileName, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------------------
// Avvisi (toast) e finestre di dialogo
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(text, { actionLabel, onAction, ms = 3500, kind = '' } = {}) {
  const el = document.getElementById('toast');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button type="button" class="toast-action">${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  if (actionLabel) {
    el.querySelector('.toast-action').onclick = () => { el.hidden = true; onAction(); };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/**
 * Apre una finestra modale. Restituisce una Promise con
 * { value, data } (data = campi del modulo) oppure null se annullata.
 * validate(value, data) può restituire un messaggio d'errore per tenerla aperta.
 */
function openModal({ title, html = '', buttons, validate }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" novalidate>
          <h2>${esc(title)}</h2>
          <div class="modal-body">${html}</div>
          <p class="modal-error" hidden></p>
          <div class="modal-actions">
            ${buttons.map((b) => `<button type="${b.value === 'cancel' ? 'button' : 'submit'}" class="btn ${b.cls || ''}" value="${esc(b.value)}">${esc(b.label)}</button>`).join('')}
          </div>
        </form>
      </div>`;
    const backdrop = root.firstElementChild;
    const form = root.querySelector('form');
    const err = root.querySelector('.modal-error');
    let clicked = null;
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    function close(result) {
      document.removeEventListener('keydown', onKey);
      root.innerHTML = '';
      resolve(result);
    }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    form.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      clicked = b.value;
      if (b.value === 'cancel') close(null);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = clicked || buttons.find((b) => b.value !== 'cancel')?.value;
      const data = Object.fromEntries(new FormData(form));
      const msg = validate ? await validate(value, data, form) : null;
      if (msg) { err.textContent = msg; err.hidden = false; form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); return; }
      close({ value, data });
    });
    const first = form.querySelector('input, select');
    (first || form.querySelector('.btn-primary') || form.querySelector('button'))?.focus();
  });
}

async function confirmDialog(title, text, okLabel = 'Conferma', danger = false) {
  const r = await openModal({
    title,
    html: `<p>${text}</p>`,
    buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: okLabel, value: 'ok', cls: danger ? 'btn-danger' : 'btn-primary' }],
  });
  return !!r;
}

/** Chiede il PIN (se impostato). Restituisce true se corretto o se non c'è PIN. */
async function askPin(reason) {
  if (!S.hasPin()) return true;
  const r = await openModal({
    title: 'Inserisci il PIN',
    html: `<p>${esc(reason)}</p>
      <input class="pin-input" name="pin" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]*" maxlength="8" aria-label="PIN">`,
    buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Conferma', value: 'ok', cls: 'btn-primary' }],
    validate: async (_v, d, form) => {
      if (await S.checkPin(d.pin)) return null;
      form.pin.value = '';
      return 'PIN errato, riprova.';
    },
  });
  if (r) ui.unlockedUntil = Date.now() + UNLOCK_MS;
  return !!r;
}

// ---------------------------------------------------------------------------
// Stato dell'esportazione (in evidenza nella griglia e nella scheda Dati)
// ---------------------------------------------------------------------------

function exportStatus() {
  const last = S.getSettings().lastExportAt;
  if (!last) return { warn: true, text: 'Nessuna esportazione da questo dispositivo', detail: 'Esporta i dati e caricali su Drive.' };
  const old = Date.now() - last > M.EXPORT_WARNING_MS;
  return {
    warn: old,
    text: `Ultima esportazione: ${M.formatDateTime(last)}`,
    detail: old ? `Sono passate più di 24 ore (${M.timeAgo(last)}): esporta e carica su Drive.` : M.timeAgo(last),
  };
}

function exportBanner(withButton) {
  const st = exportStatus();
  return `
    <section class="export-banner ${st.warn ? 'warn' : 'ok'}">
      <div class="export-icon" aria-hidden="true">${st.warn ? '!' : '✓'}</div>
      <div class="export-text"><strong>${esc(st.text)}</strong><span>${esc(st.detail)}</span></div>
      ${withButton ? '<a class="btn btn-small" href="#/dati">Esporta</a>' : ''}
    </section>`;
}

function refreshExportDot() {
  document.getElementById('export-dot').hidden = !exportStatus().warn;
}

// ---------------------------------------------------------------------------
// 1. Griglia camere e postazioni
// ---------------------------------------------------------------------------

async function renderGrid() {
  setHeader('Bucaneve', `Ronzone · ${S.getSettings().deviceName}`);
  const [locs, open] = await Promise.all([S.listLocations(), S.openSummary()]);
  let openCount = 0;
  let openTotal = 0;
  const tile = (l) => {
    const s = open.get(l.id);
    const busy = s && s.count > 0;
    if (s && s.lines) { openCount++; openTotal += s.total; }
    return `
      <a class="tile ${busy ? 'busy' : ''} ${l.kind}" href="#/loc/${esc(l.id)}" aria-label="${esc(M.locationName(l))}${busy ? ', ' + euro(s.total) : ''}">
        <span class="tile-num">${esc(l.label)}</span>
        <span class="tile-amt">${busy ? euro(s.total) : (s && s.lines ? '0,00 €' : '')}</span>
        ${l.guestName ? `<span class="tile-guest">${esc(l.guestName)}</span>` : ''}
      </a>`;
  };
  const rooms = locs.filter((l) => l.kind === 'camera').map(tile).join('');
  const extras = locs.filter((l) => l.kind === 'extra').map(tile).join('');
  $view.innerHTML = `
    ${exportBanner(true)}
    <div class="totals-strip">
      <div><span class="big">${openCount}</span> conti aperti</div>
      <div class="right">Totale aperto <span class="big">${euro(openTotal)}</span></div>
    </div>
    <h2 class="section-title">Camere</h2>
    <div class="tiles">${rooms || '<p class="empty">Nessuna camera attiva.</p>'}</div>
    <h2 class="section-title">Postazioni extra <small>clienti senza camera</small></h2>
    <div class="tiles">${extras || '<p class="empty">Nessuna postazione attiva.</p>'}</div>`;
}

// ---------------------------------------------------------------------------
// 2. Dettaglio camera: aggiunta rapida e righe del conto
// ---------------------------------------------------------------------------

async function renderLocation(id) {
  const loc = await S.getLocation(id);
  if (!loc) return renderNotFound();
  const [lines, products] = await Promise.all([S.openLines(id), S.listProducts()]);
  const totals = M.computeTotals(lines);
  setHeader(M.locationName(loc), loc.guestName || 'Conto aperto', '#/');

  // Quantità già presenti per prodotto (badge sui pulsanti)
  const qtyByProduct = new Map();
  for (const l of M.activeLines(lines)) qtyByProduct.set(l.productId, (qtyByProduct.get(l.productId) || 0) + l.qty);

  const cats = M.CATEGORIES.filter((c) => products.some((p) => p.category === c.id));
  if (!cats.some((c) => c.id === ui.category) && cats.length) ui.category = cats[0].id;

  const chips = cats.map((c) => `
    <button type="button" class="chip ${c.id === ui.category ? 'active' : ''}" data-action="category" data-id="${c.id}" aria-pressed="${c.id === ui.category}">${esc(c.label)}</button>`).join('');

  const prods = products.filter((p) => p.category === ui.category).map((p) => {
    const q = qtyByProduct.get(p.id);
    return `
      <button type="button" class="prod" data-action="add" data-id="${esc(p.id)}">
        <span class="prod-name">${esc(p.name)}</span>
        <span class="prod-price">${euro(p.price)}</span>
        ${q ? `<span class="badge" aria-label="già ${q} nel conto">${q}</span>` : ''}
      </button>`;
  }).join('');

  const rows = lines.slice().reverse().map((l) => `
    <li class="line ${l.cancelled ? 'cancelled' : ''}">
      <div class="line-main">
        <span class="line-qty">${l.qty}×</span>
        <span class="line-name">${esc(l.name)}</span>
        <span class="line-total">${euro(M.lineTotal(l))}</span>
      </div>
      <div class="line-meta">
        <span>${M.formatDate(l.createdAt)} ${M.formatTime(l.createdAt)} · ${esc(l.device || '')}${l.qty > 1 ? ` · ${euro(l.price)} cad.` : ''}</span>
        ${l.cancelled
          ? `<span class="tag">annullata ${M.formatTime(l.cancelledAt)}</span>`
          : `<span class="line-actions">
              ${M.isStayLine(l) ? '' : `<button type="button" class="btn btn-small btn-ghost" data-action="decrement" data-id="${esc(l.id)}" aria-label="Togli uno">−1</button>`}
              <button type="button" class="btn btn-small btn-ghost danger" data-action="cancel-line" data-id="${esc(l.id)}">Annulla</button>
            </span>`}
      </div>
    </li>`).join('');

  $view.innerHTML = `
    <label class="field">
      <span>Nome ospite <small>(facoltativo)</small></span>
      <input type="text" data-change="guest" data-id="${esc(id)}" value="${esc(loc.guestName)}" placeholder="es. Famiglia Rossi" autocomplete="off" enterkeyhint="done">
    </label>
    <div class="chips" role="group" aria-label="Categorie">${chips}</div>
    <div class="products">${prods || '<p class="empty">Nessun prodotto in questa categoria.</p>'}</div>
    <h2 class="section-title">Consumazioni <small>${M.activeLines(lines).length === 1 ? '1 riga' : M.activeLines(lines).length + ' righe'}</small></h2>
    ${rows ? `<ul class="lines">${rows}</ul>` : '<p class="empty">Ancora nessuna consumazione. Tocca un prodotto per aggiungerlo.</p>'}
    <div class="sticky-bar">
      <div class="sticky-total"><span>Totale</span><strong>${euro(totals.total)}</strong></div>
      <a class="btn btn-primary ${lines.length ? '' : 'disabled'}" ${lines.length ? `href="#/checkout/${esc(id)}"` : 'aria-disabled="true"'}>Check-out</a>
    </div>`;
}

// ---------------------------------------------------------------------------
// 3. Riepilogo check-out (anche per i conti chiusi dello storico)
// ---------------------------------------------------------------------------

/** Documento pulito da mostrare/stampare per il cliente. Le righe annullate non compaiono. */
function receiptHtml({ name, guestName, lines, closedAt }) {
  const active = M.activeLines(lines);
  const totals = M.computeTotals(lines);
  const period = M.periodText(lines);
  const stay = active.filter(M.isStayLine);
  const items = active.filter((l) => !M.isStayLine(l));
  const row = (l, withDate) => `
            <tr>
              <td><div>${esc(l.name)}</div>${withDate ? `<div class="muted">${M.formatDate(l.createdAt)} ${M.formatTime(l.createdAt)}</div>` : ''}</td>
              <td class="num">${l.qty} × ${euro(l.price)}</td>
              <td class="num">${euro(M.lineTotal(l))}</td>
            </tr>`;
  // Le voci di soggiorno vanno in testa; il titolo "Consumazioni" serve solo se ci sono entrambe
  const group = (title, list, withDate) => (list.length
    ? `${title ? `<tr class="group-row"><th colspan="3">${title}</th></tr>` : ''}${list.map((l) => row(l, withDate)).join('')}` : '');
  return `
    <article class="receipt" id="receipt">
      <header class="receipt-head">
        <div class="receipt-hotel">Hotel Bucaneve</div>
        <div class="receipt-place">Ronzone (TN)</div>
        <div class="receipt-nf">Riepilogo non fiscale</div>
      </header>
      <dl class="receipt-info">
        <div><dt>Postazione</dt><dd>${esc(name)}</dd></div>
        ${guestName ? `<div><dt>Ospite</dt><dd>${esc(guestName)}</dd></div>` : ''}
        <div><dt>Periodo</dt><dd>${period}</dd></div>
        <div><dt>${closedAt ? 'Conto chiuso il' : 'Data'}</dt><dd>${M.formatDateTime(closedAt || Date.now())}</dd></div>
      </dl>
      <table class="receipt-items">
        <thead><tr><th>Voce</th><th class="num">Q.tà</th><th class="num">Importo</th></tr></thead>
        <tbody>
          ${group('Soggiorno', stay, false)}
          ${group(stay.length ? 'Consumazioni' : '', items, true)}
          ${active.length ? '' : '<tr><td colspan="3" class="muted">Nessuna voce</td></tr>'}
        </tbody>
      </table>
      <table class="receipt-vat">
        <thead><tr><th>Aliquota IVA</th><th class="num">Imponibile</th><th class="num">IVA</th><th class="num">Totale</th></tr></thead>
        <tbody>
          ${totals.vat.map((v) => `<tr><td>${M.vatLabel(v.rate)}</td><td class="num">${euro(v.net)}</td><td class="num">${euro(v.tax)}</td><td class="num">${euro(v.gross)}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="receipt-total"><span>Totale</span><strong data-testid="grand-total">${euro(totals.total)}</strong></div>
      <p class="receipt-foot">Documento riepilogativo non valido ai fini fiscali. Prezzi IVA inclusa.</p>
    </article>`;
}

/** Riquadro per il personale: aggiunge conto camera, animale e tassa di soggiorno. */
function stayCardHtml(locId, lines, rates) {
  const st = ui.stay;
  if (st.loc !== locId) Object.assign(st, { loc: locId, nights: 1, persons: 1, prices: {} });
  const added = M.activeLines(lines).filter(M.isStayLine);
  const row = (type) => {
    const r = rates[type];
    if (!r || r.active === false) return '';
    const price = st.prices[type] ?? (r.price ? M.formatDecimal(r.price) : '');
    return `
      <div class="stay-row">
        <div class="stay-label"><strong>${esc(r.name)}</strong><span class="muted">€ ${M.STAY_TYPES[type].unit} · ${r.vat === 0 ? 'fuori campo IVA' : `IVA ${r.vat}%`}</span></div>
        <input type="text" inputmode="decimal" id="stay-price-${type}" data-change="stay-price" data-type="${type}" value="${esc(price)}" placeholder="0,00" aria-label="${esc(r.name)}, euro ${M.STAY_TYPES[type].unit}">
        <button type="button" class="btn btn-small btn-primary" data-action="add-stay" data-type="${type}" data-id="${esc(locId)}">Aggiungi</button>
      </div>`;
  };
  return `
    <section class="card no-print stay-card">
      <h2 class="section-title">Voci di soggiorno <small>per il personale</small></h2>
      <div class="stay-qty">
        <label class="field"><span>Notti</span><input type="number" id="stay-nights" inputmode="numeric" min="1" max="365" data-change="stay-nights" value="${st.nights}"></label>
        <label class="field"><span>Persone soggette a tassa</span><input type="number" id="stay-persons" inputmode="numeric" min="1" max="50" data-change="stay-persons" value="${st.persons}"></label>
      </div>
      ${row('room')}${row('pet')}${row('tax')}
      ${added.length ? `<ul class="lines stay-added">${added.map((l) => `
        <li class="line"><div class="line-main"><span class="line-name">${esc(l.name)}</span><span class="line-total">${euro(M.lineTotal(l))}</span></div>
          <div class="line-meta"><span>${l.qty} × ${euro(l.price)}</span>
          <button type="button" class="btn btn-small btn-ghost danger" data-action="cancel-line" data-id="${esc(l.id)}">Annulla</button></div></li>`).join('')}</ul>` : ''}
    </section>`;
}

/** Pulsanti per inviare il riepilogo: email (app di posta del telefono) e condivisione. */
function sendButtonsHtml(source, id) {
  return `
    <div class="actions no-print">
      <button type="button" class="btn btn-secondary" data-action="email-summary" data-source="${source}" data-id="${esc(id)}">Invia per email</button>
      ${navigator.share ? `<button type="button" class="btn btn-ghost" data-action="share-summary" data-source="${source}" data-id="${esc(id)}">Condividi…</button>` : ''}
    </div>`;
}

async function renderCheckout(id) {
  const loc = await S.getLocation(id);
  if (!loc) return renderNotFound();
  const [lines, rates] = await Promise.all([S.openLines(id), S.listStayRates()]);
  setHeader('Riepilogo check-out', M.locationName(loc), `#/loc/${id}`);
  $view.innerHTML = `
    ${loc.kind === 'camera' ? stayCardHtml(id, lines, rates) : ''}
    ${receiptHtml({ name: M.locationName(loc), guestName: loc.guestName, lines })}
    ${lines.length ? sendButtonsHtml('open', id) : ''}
    <div class="sticky-bar no-print">
      <button type="button" class="btn btn-secondary" data-action="print" data-title="Riepilogo ${esc(M.locationName(loc))}">Stampa / salva PDF</button>
      <button type="button" class="btn btn-primary" data-action="close-account" data-id="${esc(id)}" ${lines.length ? '' : 'disabled'}>Chiudi conto</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// 4. Storico conti chiusi
// ---------------------------------------------------------------------------

function rangeForm(prefix, from, to) {
  return `
    <div class="range">
      <label class="field"><span>Dal</span><input type="date" data-change="${prefix}-from" value="${from}"></label>
      <label class="field"><span>Al</span><input type="date" data-change="${prefix}-to" value="${to}"></label>
    </div>
    <div class="quick-range">
      <button type="button" class="chip" data-action="${prefix}-range" data-days="0">Oggi</button>
      <button type="button" class="chip" data-action="${prefix}-range" data-days="6">7 giorni</button>
      <button type="button" class="chip" data-action="${prefix}-range" data-days="29">30 giorni</button>
    </div>`;
}

async function renderHistory() {
  setHeader('Storico conti chiusi', S.getSettings().deviceName);
  const { from, to } = ui.history;
  const accounts = from <= to ? await S.listAccounts(from, to) : [];
  const sum = accounts.reduce((t, a) => t + a.total, 0);
  $view.innerHTML = `
    ${rangeForm('hist', from, to)}
    <div class="totals-strip">
      <div><span class="big">${accounts.length}</span> conti</div>
      <div class="right">Totale periodo <span class="big">${euro(sum)}</span></div>
    </div>
    ${accounts.length ? `<ul class="list">
      ${accounts.map((a) => `
        <li><a class="list-item" href="#/conto/${esc(a.id)}">
          <div><strong>${esc(a.locationName)}</strong>${a.guestName ? ` · ${esc(a.guestName)}` : ''}
            <div class="muted">${M.formatDateTime(a.closedAt)} · ${esc(a.closedBy || a.device || '')}</div></div>
          <div class="list-amt">${euro(a.total)}</div>
        </a></li>`).join('')}
    </ul>` : `<p class="empty">${from > to ? 'La data iniziale è successiva a quella finale.' : 'Nessun conto chiuso nel periodo.'}</p>`}
    <div class="actions">
      <button type="button" class="btn btn-secondary" data-action="csv-history" ${accounts.length ? '' : 'disabled'}>Esporta CSV del periodo</button>
    </div>`;
}

async function renderAccount(id) {
  const acc = await S.getAccount(id);
  if (!acc) return renderNotFound();
  const lines = await S.accountLines(id);
  const cancelled = lines.filter((l) => l.cancelled);
  setHeader('Conto chiuso', acc.locationName, '#/storico');
  $view.innerHTML = `
    ${receiptHtml({ name: acc.locationName, guestName: acc.guestName, lines, closedAt: acc.closedAt })}
    <div class="actions no-print">
      <button type="button" class="btn btn-secondary" data-action="print" data-title="Riepilogo ${esc(acc.locationName)} ${M.dateKey(acc.closedAt)}">Stampa / salva PDF</button>
    </div>
    ${sendButtonsHtml('closed', id)}
    <p class="muted no-print center">Chiuso da: ${esc(acc.closedBy || acc.device)}</p>
    ${cancelled.length ? `
      <section class="card no-print">
        <h2 class="section-title">Righe annullate <small>non addebitate</small></h2>
        <ul class="lines">${cancelled.map((l) => `
          <li class="line cancelled"><div class="line-main"><span class="line-qty">${l.qty}×</span><span class="line-name">${esc(l.name)}</span><span class="line-total">${euro(M.lineTotal(l))}</span></div>
          <div class="line-meta"><span>${M.formatDateTime(l.createdAt)}</span><span class="tag">annullata ${M.formatDateTime(l.cancelledAt)}</span></div></li>`).join('')}
        </ul>
      </section>` : ''}`;
}

// ---------------------------------------------------------------------------
// Dati: esporta, importa, CSV
// ---------------------------------------------------------------------------

function importSummaryHtml(r) {
  const labels = { consumptions: 'Consumazioni', accounts: 'Conti chiusi', products: 'Prodotti del listino', locations: 'Camere e postazioni' };
  const rows = Object.entries(labels).map(([k, label]) => {
    const s = r.stores[k];
    return `<tr><td>${label}</td><td class="num">${s.added.length}</td><td class="num">${s.updated.length}</td><td class="num">${s.skipped}</td></tr>`;
  }).join('');
  const nothing = Object.values(r.stores).every((s) => !s.toWrite.length);
  return `
    <section class="card import-result" data-testid="import-result">
      <h2 class="section-title">Importazione completata</h2>
      <p>File di <strong>${esc(r.from)}</strong> esportato il ${r.exportedAt ? M.formatDateTime(r.exportedAt) : '—'}.</p>
      ${nothing ? '<p class="ok-text">Nessuna novità: questo dispositivo era già aggiornato.</p>' : ''}
      <div class="table-wrap"><table class="simple">
        <thead><tr><th></th><th class="num">Nuovi</th><th class="num">Aggior&shy;nati</th><th class="num">Già presenti</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${r.openByLocation.length ? `<h3>Nuove consumazioni su conti aperti</h3><ul class="bullets">${r.openByLocation.map((o) => `<li>${esc(o.name)}: ${o.lines} ${o.lines === 1 ? 'riga' : 'righe'}, ${euro(o.total)}</li>`).join('')}</ul>` : ''}
      ${r.newAccounts.length ? `<h3>Nuovi conti chiusi</h3><ul class="bullets">${r.newAccounts.map((a) => `<li>${esc(a.locationName)}${a.guestName ? ' · ' + esc(a.guestName) : ''} — ${M.formatDateTime(a.closedAt)} — ${euro(a.total)}</li>`).join('')}</ul>` : ''}
    </section>`;
}

async function renderData() {
  setHeader('Dati e sincronizzazione', S.getSettings().deviceName);
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] }));
  $view.innerHTML = `
    ${exportBanner(false)}
    <section class="card">
      <h2 class="section-title">1 · Esporta</h2>
      <p>Scarica un file con tutti i dati di questo dispositivo, poi caricalo nella cartella condivisa su Google Drive.</p>
      <button type="button" class="btn btn-primary btn-block" data-action="export-json">Esporta dati</button>
      ${canShare ? '<button type="button" class="btn btn-secondary btn-block" data-action="share-json">Condividi su Drive…</button>' : ''}
    </section>
    <section class="card">
      <h2 class="section-title">2 · Importa</h2>
      <p>Scarica da Drive i file degli altri dispositivi e importali qui, uno alla volta. I dati vengono uniti senza doppioni: vince sempre la modifica più recente.</p>
      <label class="btn btn-secondary btn-block file-btn">
        Scegli file da importare
        <input type="file" accept=".json,application/json" data-change="import-file" hidden>
      </label>
    </section>
    ${ui.importResult ? importSummaryHtml(ui.importResult) : ''}
    <section class="card">
      <h2 class="section-title">Esporta CSV per Excel</h2>
      <p>Conti chiusi nel periodo, una riga per consumazione.</p>
      ${rangeForm('csv', ui.csv.from, ui.csv.to)}
      <button type="button" class="btn btn-secondary btn-block" data-action="csv-data">Esporta CSV</button>
    </section>`;
}

async function doExport(share) {
  const { payload, fileName } = await S.exportData();
  const json = JSON.stringify(payload);
  if (share) {
    const file = new File([json], fileName, { type: 'application/json' });
    try {
      await navigator.share({ files: [file], title: fileName });
    } catch (e) {
      if (e.name === 'AbortError') return; // condivisione annullata dall'utente
      throw e;
    }
  } else {
    download(fileName, json, 'application/json');
  }
  await S.markExported();
  refreshExportDot();
  toast(`Esportato: ${fileName}`, { ms: 5000 });
  render();
}

async function doImport(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (!(await askPin('Serve il PIN per importare dati.'))) return;
  let obj;
  try {
    obj = JSON.parse(await file.text());
  } catch {
    toast('Il file non è un JSON valido.', { kind: 'error', ms: 5000 });
    return;
  }
  try {
    ui.importResult = await S.importData(obj);
    toast('Importazione completata');
  } catch (e) {
    toast(e.message, { kind: 'error', ms: 6000 });
  }
  render();
}

async function doCsv(from, to) {
  if (from > to) { toast('La data iniziale è successiva a quella finale.', { kind: 'error' }); return; }
  const r = await S.exportCsv(from, to);
  if (!r.accounts) { toast('Nessun conto chiuso nel periodo.', { kind: 'error' }); return; }
  download(r.fileName, r.csv, 'text/csv;charset=utf-8');
  toast(`CSV esportato: ${r.accounts} conti`);
}

// ---------------------------------------------------------------------------
// 5. Impostazioni (protette dal PIN, se impostato)
// ---------------------------------------------------------------------------

async function renderSettings() {
  setHeader('Impostazioni', S.getSettings().deviceName);
  if (S.hasPin() && Date.now() > ui.unlockedUntil) {
    $view.innerHTML = `
      <section class="card center">
        <p>Le impostazioni sono protette dal PIN.</p>
        <button type="button" class="btn btn-primary btn-block" data-action="unlock">Sblocca</button>
      </section>`;
    return;
  }
  const settings = S.getSettings();
  const [products, locs, open, stayRates] = await Promise.all([
    S.listProducts({ includeInactive: true }), S.listLocations({ includeInactive: true }), S.openSummary(), S.listStayRates(),
  ]);
  const active = products.filter((p) => p.active !== false);
  const inactive = products.filter((p) => p.active === false);

  const listino = M.CATEGORIES.map((c) => {
    const items = active.filter((p) => p.category === c.id);
    if (!items.length) return '';
    return `<h3>${esc(c.label)}</h3><ul class="list">${items.map((p) => `
      <li><button type="button" class="list-item" data-action="edit-product" data-id="${esc(p.id)}">
        <div>${esc(p.name)}<div class="muted">IVA ${p.vat}%</div></div>
        <div class="list-amt">${euro(p.price)}</div>
      </button></li>`).join('')}</ul>`;
  }).join('');

  const locRow = (l) => {
    const busy = open.has(l.id);
    return `
      <li class="loc-row ${l.active === false ? 'inactive' : ''}">
        <input type="text" value="${esc(l.label)}" data-change="loc-label" data-id="${esc(l.id)}" aria-label="Nome ${esc(M.locationName(l))}" maxlength="24">
        <button type="button" class="btn btn-small ${l.active === false ? 'btn-secondary' : 'btn-ghost'}" data-action="toggle-location" data-id="${esc(l.id)}" ${busy && l.active !== false ? 'disabled title="Conto aperto"' : ''}>
          ${l.active === false ? 'Riattiva' : 'Nascondi'}
        </button>
      </li>`;
  };

  $view.innerHTML = `
    <section class="card">
      <h2 class="section-title">Questo dispositivo</h2>
      <label class="field"><span>Nome dispositivo <small>(compare nei file esportati, es. BAR, RECEPTION)</small></span>
        <input type="text" data-change="device-name" value="${esc(settings.deviceName)}" maxlength="30" autocomplete="off"></label>
    </section>

    <section class="card">
      <h2 class="section-title">PIN</h2>
      <p>${S.hasPin() ? 'Il PIN è attivo: viene chiesto per chiudere i conti, importare dati e aprire le impostazioni.' : 'Nessun PIN impostato. Facoltativo: protegge chiusura conti, importazione e impostazioni.'}</p>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="set-pin">${S.hasPin() ? 'Cambia PIN' : 'Imposta PIN'}</button>
        ${S.hasPin() ? '<button type="button" class="btn btn-ghost danger" data-action="remove-pin">Rimuovi PIN</button>' : ''}
      </div>
    </section>

    <section class="card">
      <h2 class="section-title">Listino <small>${active.length} prodotti</small></h2>
      <button type="button" class="btn btn-primary btn-block" data-action="new-product">+ Nuovo prodotto</button>
      ${listino}
      ${inactive.length ? `<details><summary>Prodotti disattivati (${inactive.length})</summary><ul class="list">${inactive.map((p) => `
        <li><button type="button" class="list-item" data-action="edit-product" data-id="${esc(p.id)}"><div>${esc(p.name)}</div><div class="list-amt">${euro(p.price)}</div></button></li>`).join('')}</ul></details>` : ''}
    </section>

    <section class="card">
      <h2 class="section-title">Voci di soggiorno</h2>
      <p class="muted">Tariffe proposte nel check-out delle camere (modificabili anche lì, conto per conto).</p>
      <ul class="list">${Object.entries(stayRates).map(([type, r]) => r ? `
        <li><button type="button" class="list-item" data-action="edit-stay" data-type="${type}">
          <div>${esc(r.name)}<div class="muted">€ ${M.STAY_TYPES[type].unit} · ${r.vat === 0 ? 'fuori campo IVA' : `IVA ${r.vat}%`}</div></div>
          <div class="list-amt">${r.price ? euro(r.price) : 'al check-out'}</div>
        </button></li>` : '').join('')}</ul>
    </section>

    <section class="card">
      <h2 class="section-title">Camere</h2>
      <p class="muted">Tocca un numero per modificarlo. "Nascondi" toglie la casella dalla griglia (non possibile con un conto aperto).</p>
      <ul class="loc-list">${locs.filter((l) => l.kind === 'camera').map(locRow).join('')}</ul>
      <button type="button" class="btn btn-secondary btn-block" data-action="add-location" data-kind="camera">+ Aggiungi camera</button>
      <h2 class="section-title">Postazioni extra</h2>
      <ul class="loc-list">${locs.filter((l) => l.kind === 'extra').map(locRow).join('')}</ul>
      <button type="button" class="btn btn-secondary btn-block" data-action="add-location" data-kind="extra">+ Aggiungi postazione</button>
    </section>

    <section class="card danger-zone">
      <h2 class="section-title">Cancella dati</h2>
      <p>Elimina tutti i dati salvati su questo dispositivo (conti aperti, storico, listino). Esporta prima i dati!</p>
      <button type="button" class="btn btn-danger btn-block" data-action="reset">Cancella tutti i dati locali</button>
    </section>

    <p class="muted center">Bucaneve · versione ${APP_VERSION}<br>I dati restano solo su questo dispositivo finché non li esporti.</p>`;
}

async function editProduct(id) {
  const p = id ? (await S.listProducts({ includeInactive: true })).find((x) => x.id === id) : null;
  const isNew = !p;
  const cur = p || { name: '', price: 0, vat: 10, category: ui.category || 'caffetteria', active: true };
  const buttons = [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }];
  if (!isNew) buttons.push({ label: cur.active === false ? 'Riattiva' : 'Disattiva', value: 'toggle', cls: 'btn-ghost danger' });
  buttons.push({ label: 'Salva', value: 'save', cls: 'btn-primary' });
  const r = await openModal({
    title: isNew ? 'Nuovo prodotto' : 'Modifica prodotto',
    html: `
      <label class="field"><span>Nome</span><input name="name" type="text" value="${esc(cur.name)}" maxlength="40" required autocomplete="off"></label>
      <label class="field"><span>Prezzo (€, IVA inclusa)</span><input name="price" type="text" inputmode="decimal" value="${isNew ? '' : esc(M.formatDecimal(cur.price))}" placeholder="0,00"></label>
      <label class="field"><span>Categoria</span><select name="category">${M.CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === cur.category ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
      <label class="field"><span>Aliquota IVA</span><select name="vat">${M.VAT_RATES.map((v) => `<option value="${v}" ${v === cur.vat ? 'selected' : ''}>${v}%</option>`).join('')}</select></label>`,
    buttons,
    validate: (value, d) => {
      if (value === 'toggle') return null;
      if (!d.name.trim()) return 'Inserisci il nome.';
      if (Number.isNaN(M.parseEuro(d.price))) return 'Prezzo non valido (es. 3,50).';
      return null;
    },
  });
  if (!r) return;
  if (r.value === 'toggle') {
    await S.setProductActive(p.id, cur.active === false);
    toast(cur.active === false ? 'Prodotto riattivato' : 'Prodotto disattivato');
  } else {
    await S.saveProduct({ id: p?.id, name: r.data.name, price: M.parseEuro(r.data.price), vat: Number(r.data.vat), category: r.data.category });
    toast('Listino aggiornato');
  }
  render();
}

/** Dati per email/condivisione, dal conto aperto di una postazione o da un conto chiuso. */
async function summaryData(source, id) {
  let name; let guestName; let email; let lines; let closedAt;
  if (source === 'open') {
    const loc = await S.getLocation(id);
    ({ guestName, guestEmail: email } = loc);
    name = M.locationName(loc);
    lines = await S.openLines(id);
  } else {
    const acc = await S.getAccount(id);
    ({ locationName: name, guestName, guestEmail: email, closedAt } = acc);
    lines = await S.accountLines(id);
  }
  return {
    email: email || '',
    subject: `Riepilogo ${name} – Hotel Bucaneve`,
    text: M.buildTextSummary({ hotel: HOTEL, name, guestName, lines, closedAt }),
  };
}

function renderNotFound() {
  setHeader('Non trovato', '', '#/');
  $view.innerHTML = '<p class="empty">Elemento non trovato. <a href="#/">Torna alle camere</a></p>';
}

// ---------------------------------------------------------------------------
// Azioni (delegazione degli eventi: un solo listener per tutta la pagina)
// ---------------------------------------------------------------------------

function setRange(target, days) {
  target.from = M.dateKey(Date.now() - days * 864e5);
  target.to = M.dateKey(Date.now());
}

const actions = {
  back: () => go(ui.backTo || '#/'),

  category: (el) => { ui.category = el.dataset.id; render(); },

  add: async (el) => {
    const locId = currentParam();
    const { line, merged } = await S.addConsumption(locId, el.dataset.id);
    if (navigator.vibrate) navigator.vibrate(15);
    await render();
    toast(`${line.name} ×${line.qty}${merged ? '' : ' aggiunto'}`, {
      actionLabel: 'Annulla',
      onAction: async () => { await S.decrementLine(line.id); render(); },
    });
  },

  decrement: async (el) => { await S.decrementLine(el.dataset.id); render(); },

  'cancel-line': async (el) => {
    if (!(await confirmDialog('Annullare la riga?', 'La riga resterà visibile nello storico come <strong>annullata</strong> e non verrà addebitata.', 'Annulla riga', true))) return;
    await S.cancelLine(el.dataset.id);
    render();
  },

  print: (el) => {
    const old = document.title;
    document.title = el.dataset.title || old; // nome proposto per il PDF
    window.print();
    setTimeout(() => { document.title = old; }, 500);
  },

  'close-account': async (el) => {
    const id = el.dataset.id;
    if (!(await askPin('Serve il PIN per chiudere il conto.'))) return;
    const loc = await S.getLocation(id);
    const total = M.computeTotals(await S.openLines(id)).total;
    if (!(await confirmDialog('Chiudere il conto?', `${esc(M.locationName(loc))} — totale <strong>${euro(total)}</strong>.<br>Le consumazioni passano nello storico e la camera viene liberata.`, 'Chiudi conto'))) return;
    const acc = await S.closeAccount(id);
    ui.pendingToast = [`Conto chiuso: ${acc.locationName} · ${euro(acc.total)}`, { ms: 5000 }];
    go('#/');
  },

  'add-stay': async (el) => {
    const type = el.dataset.type;
    const rates = await S.listStayRates();
    const price = M.parseEuro(document.getElementById(`stay-price-${type}`).value);
    if (Number.isNaN(price) || price <= 0) {
      toast('Inserisci l\'importo (es. 120,00).', { kind: 'error' });
      document.getElementById(`stay-price-${type}`).focus();
      return;
    }
    const nights = Number(document.getElementById('stay-nights').value);
    const persons = Number(document.getElementById('stay-persons').value);
    const line = await S.addStayCharge(el.dataset.id, type, { nights, persons, price, vat: rates[type].vat });
    toast(`${line.name}: ${euro(M.lineTotal(line))}`);
    render();
  },

  'edit-stay': async (el) => {
    const type = el.dataset.type;
    const r = (await S.listStayRates())[type];
    const res = await openModal({
      title: r.name,
      html: `
        <label class="field"><span>Importo € ${M.STAY_TYPES[type].unit}${type === 'room' ? ' (vuoto = da inserire al check-out)' : ''}</span>
          <input name="price" type="text" inputmode="decimal" value="${r.price ? esc(M.formatDecimal(r.price)) : ''}" placeholder="0,00"></label>
        <label class="field"><span>Aliquota IVA</span><select name="vat">${M.VAT_RATES.map((v) => `<option value="${v}" ${v === r.vat ? 'selected' : ''}>${esc(M.vatLabel(v))}</option>`).join('')}</select></label>`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Salva', value: 'save', cls: 'btn-primary' }],
      validate: (_v, d) => (d.price.trim() === '' || !Number.isNaN(M.parseEuro(d.price)) ? null : 'Importo non valido (es. 1,50).'),
    });
    if (!res) return;
    const price = res.data.price.trim() === '' ? 0 : M.parseEuro(res.data.price);
    await S.saveStayRate(type, { price, vat: Number(res.data.vat) });
    toast('Tariffa aggiornata');
    render();
  },

  'email-summary': async (el) => {
    const data = await summaryData(el.dataset.source, el.dataset.id);
    const res = await openModal({
      title: 'Invia il riepilogo per email',
      html: `
        <p>Si apre l'app di posta del telefono con il riepilogo già scritto: controlla e premi Invia.</p>
        <label class="field"><span>Email dell'ospite</span>
          <input name="email" type="email" inputmode="email" autocomplete="off" autocapitalize="off" value="${esc(data.email)}" placeholder="nome@esempio.it"></label>`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Apri email', value: 'ok', cls: 'btn-primary' }],
      validate: (_v, d) => (!d.email.trim() || M.isEmail(d.email) ? null : 'Indirizzo email non valido.'),
    });
    if (!res) return;
    const email = res.data.email.trim();
    if (el.dataset.source === 'open' && email !== data.email) await S.setGuestEmail(el.dataset.id, email);
    const a = document.createElement('a');
    a.href = M.mailtoHref(email, data.subject, data.text);
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  'share-summary': async (el) => {
    const data = await summaryData(el.dataset.source, el.dataset.id);
    try {
      await navigator.share({ title: data.subject, text: data.text });
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
  },

  'hist-range': (el) => { setRange(ui.history, Number(el.dataset.days)); render(); },
  'csv-range': (el) => { setRange(ui.csv, Number(el.dataset.days)); render(); },
  'csv-history': () => doCsv(ui.history.from, ui.history.to),
  'csv-data': () => doCsv(ui.csv.from, ui.csv.to),

  'export-json': () => doExport(false),
  'share-json': () => doExport(true),

  unlock: async () => { if (await askPin('Inserisci il PIN per aprire le impostazioni.')) render(); },

  'set-pin': async () => {
    const r = await openModal({
      title: S.hasPin() ? 'Cambia PIN' : 'Imposta PIN',
      html: `<p>Da 4 a 8 cifre.</p>
        <label class="field"><span>Nuovo PIN</span><input class="pin-input" name="pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>
        <label class="field"><span>Ripeti PIN</span><input class="pin-input" name="pin2" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Salva', value: 'ok', cls: 'btn-primary' }],
      validate: (_v, d) => {
        if (!/^\d{4,8}$/.test(d.pin)) return 'Il PIN deve avere da 4 a 8 cifre.';
        if (d.pin !== d.pin2) return 'I due PIN non coincidono.';
        return null;
      },
    });
    if (!r) return;
    await S.setPin(r.data.pin);
    ui.unlockedUntil = Date.now() + UNLOCK_MS;
    toast('PIN salvato');
    render();
  },

  'remove-pin': async () => {
    if (!(await confirmDialog('Rimuovere il PIN?', 'Chiusura conti e impostazioni non saranno più protette.', 'Rimuovi', true))) return;
    await S.setPin('');
    toast('PIN rimosso');
    render();
  },

  'new-product': () => editProduct(null),
  'edit-product': (el) => editProduct(el.dataset.id),

  'toggle-location': async (el) => {
    const loc = await S.getLocation(el.dataset.id);
    await S.updateLocation(loc.id, { active: loc.active === false });
    render();
  },

  'add-location': async (el) => {
    const kind = el.dataset.kind;
    const r = await openModal({
      title: kind === 'camera' ? 'Nuova camera' : 'Nuova postazione',
      html: `<label class="field"><span>${kind === 'camera' ? 'Numero o nome camera' : 'Nome postazione'}</span><input name="label" type="text" maxlength="24" autocomplete="off"></label>`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Aggiungi', value: 'ok', cls: 'btn-primary' }],
      validate: (_v, d) => (d.label.trim() ? null : 'Inserisci un nome.'),
    });
    if (!r) return;
    await S.addLocation(kind, r.data.label);
    render();
  },

  reset: async () => {
    const r = await openModal({
      title: 'Cancellare tutti i dati?',
      html: '<p>Operazione irreversibile. Per confermare scrivi <strong>CANCELLA</strong>.</p><input name="confirm" type="text" autocomplete="off" autocapitalize="characters">',
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Cancella tutto', value: 'ok', cls: 'btn-danger' }],
      validate: (_v, d) => (d.confirm.trim().toUpperCase() === 'CANCELLA' ? null : 'Scrivi CANCELLA per confermare.'),
    });
    if (!r) return;
    await S.resetAll();
    ui.importResult = null;
    ui.unlockedUntil = 0;
    refreshExportDot();
    ui.pendingToast = ['Dati cancellati'];
    go('#/');
  },

  'apply-update': () => {
    updateRequested = true;
    waitingWorker?.postMessage('SKIP_WAITING');
  },
};

/** Gestori dei campi modificabili (evento "change"). */
const changes = {
  'stay-nights': (el) => { ui.stay.nights = Math.max(1, parseInt(el.value, 10) || 1); el.value = ui.stay.nights; },
  'stay-persons': (el) => { ui.stay.persons = Math.max(1, parseInt(el.value, 10) || 1); el.value = ui.stay.persons; },
  'stay-price': (el) => { ui.stay.prices[el.dataset.type] = el.value; },
  guest: async (el) => { await S.setGuestName(el.dataset.id, el.value); render(); },
  'hist-from': (el) => { ui.history.from = el.value || ui.history.from; render(); },
  'hist-to': (el) => { ui.history.to = el.value || ui.history.to; render(); },
  'csv-from': (el) => { ui.csv.from = el.value || ui.csv.from; },
  'csv-to': (el) => { ui.csv.to = el.value || ui.csv.to; },
  'import-file': (el) => doImport(el),
  'device-name': async (el) => {
    const name = el.value.trim();
    if (!name) { el.value = S.getSettings().deviceName; return; }
    await S.saveSettings({ deviceName: name });
    toast('Nome dispositivo salvato');
    render();
  },
  'loc-label': async (el) => {
    const label = el.value.trim();
    if (!label) { render(); return; }
    await S.updateLocation(el.dataset.id, { label });
    toast('Nome aggiornato');
  },
};

function handleError(e) {
  console.error(e);
  toast(e?.message || 'Si è verificato un errore', { kind: 'error', ms: 6000 });
}

let busy = false; // evita doppi tocchi mentre un'azione è in corso (tranne "add", che è in coda)
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  const exclusive = el.dataset.action !== 'add';
  if (exclusive && busy) return;
  if (exclusive) busy = true;
  try { await fn(el, e); } catch (err) { handleError(err); } finally { if (exclusive) busy = false; }
});

document.addEventListener('change', async (e) => {
  const fn = changes[e.target.dataset?.change];
  if (!fn) return;
  try { await fn(e.target); } catch (err) { handleError(err); }
});

// Invio nel campo ospite = conferma e chiudi tastiera
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[data-change="guest"]')) e.target.blur();
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = [
  [/^\/$/, renderGrid, 'camere'],
  [/^\/loc\/([^/]+)$/, renderLocation, 'camere'],
  [/^\/checkout\/([^/]+)$/, renderCheckout, 'camere'],
  [/^\/storico$/, renderHistory, 'storico'],
  [/^\/conto\/([^/]+)$/, renderAccount, 'storico'],
  [/^\/dati$/, renderData, 'dati'],
  [/^\/impostazioni$/, renderSettings, 'impostazioni'],
];

function currentPath() {
  return location.hash.replace(/^#/, '') || '/';
}

function currentParam() {
  const m = currentPath().match(/^\/[^/]+\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

let lastPath = null;
async function render() {
  const path = currentPath();
  const route = routes.find(([re]) => re.test(path));
  if (!route) { location.hash = '#/'; return; }
  const [re, fn, tab] = route;
  const param = path.match(re)[1];
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.body.dataset.route = path.split('/')[1] || 'camere';
  try {
    await fn(param && decodeURIComponent(param));
  } catch (e) {
    handleError(e);
  }
  if (path !== lastPath) {
    window.scrollTo(0, 0);
    // Un avviso della schermata precedente (es. "Annulla" un'aggiunta) non vale più qui
    if (lastPath !== null) document.getElementById('toast').hidden = true;
    lastPath = path;
  }
  if (ui.pendingToast) { toast(...ui.pendingToast); ui.pendingToast = null; }
  refreshExportDot();
}

window.addEventListener('hashchange', render);

// ---------------------------------------------------------------------------
// Service worker (offline) e avvio
// ---------------------------------------------------------------------------

let waitingWorker = null;
let updateRequested = false;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const showUpdate = (w) => { waitingWorker = w; document.getElementById('update-bar').hidden = false; };
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
      });
    });
  }).catch((e) => console.warn('Service worker non registrato', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
  });
}

async function start() {
  try {
    await S.init();
    // Chiede al browser di non cancellare i dati quando lo spazio scarseggia.
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    $view.innerHTML = `<section class="card"><h2 class="section-title">Impossibile aprire l'archivio</h2>
      <p>${esc(e.message)}</p><p>Se usi la navigazione privata, aprila in una finestra normale.</p></section>`;
    return;
  }
  await render();
  registerServiceWorker();
}

start();
