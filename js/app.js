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
import * as Sync from './sync.js';
import * as Admin from './admin.js';

const APP_VERSION = '1.4.2';
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
  login: { tab: 'staff', code: '', hotelName: '', staff: null, selected: null }, // schermata di accesso
  pendingRender: false, // aggiornamento rimandato perché l'utente sta scrivendo
};


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

/**
 * Legge un'immagine scelta dall'utente e la riduce (max 800×300 px) per
 * tenerla leggera nei file di sincronizzazione. Restituisce un data URL PNG.
 */
function imageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) { reject(new Error('Il file scelto non è un\'immagine.')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 800 / img.naturalWidth, 300 / img.naturalHeight);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Impossibile leggere l\'immagine.')); };
    img.src = url;
  });
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
function openModal({ title, html = '', buttons, validate, onOpen }) {
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
    onOpen?.(form);
    const first = form.querySelector('input:not([readonly]), select');
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

/** Stato della sincronizzazione con il server, in parole. */
function syncStatus() {
  const st = Sync.getState();
  const n = st.pending;
  const waiting = n ? ` · ${n === 1 ? '1 modifica' : `${n} modifiche`} in attesa` : '';
  if (st.status === 'offline') return { warn: true, text: 'Offline: lavori sul dispositivo', detail: `Le modifiche partono appena torna la rete${waiting}.` };
  if (st.status === 'error') return { warn: true, text: 'Sincronizzazione non riuscita', detail: `${st.error}${waiting}` };
  if (!st.lastSyncAt) return { warn: false, text: 'Collegamento al server…', detail: '' };
  return { warn: false, text: 'Sincronizzato', detail: `Ultimo aggiornamento alle ${M.formatTime(st.lastSyncAt)}${waiting}` };
}

function exportBanner(withButton) {
  if (Sync.isServer()) {
    const st = syncStatus();
    return `
    <section class="export-banner ${st.warn ? 'warn' : 'ok'}" id="sync-banner" data-testid="sync-banner">
      <div class="export-icon" aria-hidden="true">${st.warn ? '!' : '✓'}</div>
      <div class="export-text"><strong>${esc(st.text)}</strong><span>${esc(st.detail)}</span></div>
      ${withButton && st.warn ? '<button type="button" class="btn btn-small" data-action="sync-now">Riprova</button>' : ''}
    </section>`;
  }
  const st = exportStatus();
  return `
    <section class="export-banner ${st.warn ? 'warn' : 'ok'}">
      <div class="export-icon" aria-hidden="true">${st.warn ? '!' : '✓'}</div>
      <div class="export-text"><strong>${esc(st.text)}</strong><span>${esc(st.detail)}</span></div>
      ${withButton ? '<a class="btn btn-small" href="#/dati">Esporta</a>' : ''}
    </section>`;
}

function refreshExportDot() {
  document.getElementById('export-dot').hidden = !(Sync.isServer() ? syncStatus().warn : exportStatus().warn);
}

/** Aggiorna banner e pallino quando cambia lo stato della sincronizzazione. */
function refreshSyncIndicators() {
  refreshExportDot();
  const banner = document.getElementById('sync-banner');
  if (banner) banner.outerHTML = exportBanner(currentPath() === '/');
}

// ---------------------------------------------------------------------------
// 1. Griglia camere e postazioni
// ---------------------------------------------------------------------------

async function renderGrid() {
  const u = Sync.user();
  setHeader(u ? u.hotel.name : 'Bucaneve', u ? `${u.name}` : `Ronzone · ${S.getSettings().deviceName}`);
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
    // Tocco sul prodotto = +1; il "−" (visibile quando è già nel conto) toglie un pezzo
    return `
      <div class="prod ${q ? 'has-qty' : ''}">
        <button type="button" class="prod-add" data-action="add" data-id="${esc(p.id)}">
          <span class="prod-name">${esc(p.name)}</span>
          <span class="prod-price">${euro(p.price)}</span>
        </button>
        ${q ? `<span class="badge" aria-label="${q} nel conto">${q}</span>
        <button type="button" class="prod-minus" data-action="remove-one" data-id="${esc(p.id)}" aria-label="Togli un ${esc(p.name)}">−</button>` : ''}
      </div>`;
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
              ${M.isStayLine(l) ? '' : `<span class="stepper" role="group" aria-label="Quantità ${esc(l.name)}">
                <button type="button" data-action="decrement" data-id="${esc(l.id)}" data-qty="${l.qty}" aria-label="Togli uno">−</button>
                <button type="button" class="stepper-qty" data-action="set-qty" data-id="${esc(l.id)}" data-qty="${l.qty}" aria-label="Quantità ${l.qty}: tocca per scriverla">${l.qty}</button>
                <button type="button" data-action="increment" data-id="${esc(l.id)}" aria-label="Aggiungi uno">+</button>
              </span>`}
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

/**
 * Documento da mostrare/stampare per il cliente (impaginato anche per A4).
 * Le righe annullate non compaiono; le voci di soggiorno vanno in testa.
 */
function receiptHtml(hotel, { name, guestName, lines, closedAt, ref }) {
  const active = M.activeLines(lines);
  const totals = M.computeTotals(lines);
  const stay = active.filter(M.isStayLine);
  const items = active.filter((l) => !M.isStayLine(l));
  const row = (l, withDate) => `
          <tr>
            <td class="c-date">${withDate ? `${M.formatDate(l.createdAt)}<br><span class="muted">${M.formatTime(l.createdAt)}</span>` : ''}</td>
            <td class="c-desc">${esc(l.name)}${withDate ? `<div class="muted only-narrow">${M.formatDate(l.createdAt)} ${M.formatTime(l.createdAt)}</div>` : ''}</td>
            <td class="num c-qty">${l.qty}</td>
            <td class="num c-price">${euro(l.price)}</td>
            <td class="num c-amt">${euro(M.lineTotal(l))}</td>
          </tr>`;
  const sub = (list) => list.reduce((t, l) => t + M.lineTotal(l), 0);
  const group = (title, list, withDate) => (list.length ? `
        <tbody>
          <tr class="group-row"><th colspan="4">${title}</th><th class="num">${euro(sub(list))}</th></tr>
          ${list.map((l) => row(l, withDate)).join('')}
        </tbody>` : '');
  const contacts = [hotel.phone && `Tel. ${esc(hotel.phone)}`, hotel.email && esc(hotel.email)].filter(Boolean).join(' · ');
  return `
    <article class="receipt" id="receipt">
      <header class="rc-head">
        <div class="rc-brand">
          ${hotel.logo ? `<img class="rc-logo" src="${esc(hotel.logo)}" alt="${esc(hotel.name)}">` : `<div class="rc-name">${esc(hotel.name)}</div>`}
          ${hotel.place ? `<div class="rc-place">${esc(hotel.place)}</div>` : ''}
        </div>
        <div class="rc-legal">
          ${hotel.company ? `<strong>${esc(hotel.company)}</strong>` : ''}
          ${hotel.address ? `<span>${esc(hotel.address)}</span>` : ''}
          ${hotel.vatNumber ? `<span>P.IVA ${esc(hotel.vatNumber)}</span>` : ''}
          ${contacts ? `<span>${contacts}</span>` : ''}
        </div>
      </header>
      <div class="rc-title">
        <h2>Riepilogo conto</h2>
        <span class="receipt-nf">Riepilogo non fiscale</span>
      </div>
      <dl class="receipt-info">
        <div><dt>Camera / postazione</dt><dd>${esc(name)}</dd></div>
        <div><dt>Ospite</dt><dd>${guestName ? esc(guestName) : '—'}</dd></div>
        <div><dt>Periodo</dt><dd>${M.periodText(lines)}</dd></div>
        <div><dt>${closedAt ? 'Chiuso il' : 'Data'}</dt><dd>${M.formatDateTime(closedAt || Date.now())}</dd></div>
        ${ref ? `<div><dt>Riferimento</dt><dd class="mono">${esc(ref)}</dd></div>` : ''}
      </dl>
      <table class="receipt-items">
        <thead><tr><th class="c-date">Data</th><th class="c-desc">Descrizione</th><th class="num c-qty">Q.tà</th><th class="num c-price">Prezzo</th><th class="num c-amt">Importo</th></tr></thead>
        ${group('Soggiorno', stay, false)}
        ${group('Consumazioni', items, true)}
        ${active.length ? '' : '<tbody><tr><td colspan="5" class="muted">Nessuna voce</td></tr></tbody>'}
      </table>
      <div class="rc-bottom">
        <table class="receipt-vat">
          <thead><tr><th>Aliquota IVA</th><th class="num">Imponibile</th><th class="num">IVA</th><th class="num">Totale</th></tr></thead>
          <tbody>
            ${totals.vat.map((v) => `<tr><td>${M.vatLabel(v.rate)}</td><td class="num">${euro(v.net)}</td><td class="num">${euro(v.tax)}</td><td class="num">${euro(v.gross)}</td></tr>`).join('')}
          </tbody>
        </table>
        <div class="receipt-total"><span>Totale da pagare</span><strong data-testid="grand-total">${euro(totals.total)}</strong></div>
      </div>
      <div class="rc-sign">
        <div class="sign-box"><span>Firma per accettazione</span></div>
      </div>
      <footer class="rc-foot">
        ${hotel.footer ? `<p class="rc-thanks">${esc(hotel.footer)}</p>` : ''}
        <p>Documento riepilogativo non valido ai fini fiscali. Prezzi IVA inclusa.</p>
      </footer>
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
  const [lines, rates, hotel] = await Promise.all([S.openLines(id), S.listStayRates(), S.getHotel()]);
  setHeader('Riepilogo check-out', M.locationName(loc), `#/loc/${id}`);
  $view.innerHTML = `
    ${loc.kind === 'camera' ? stayCardHtml(id, lines, rates) : ''}
    ${receiptHtml(hotel, { name: M.locationName(loc), guestName: loc.guestName, lines })}
    ${lines.length ? sendButtonsHtml('open', id) : ''}
    <div class="sticky-bar no-print">
      <button type="button" class="btn btn-secondary" data-action="print" data-title="Riepilogo ${esc(M.locationName(loc))}">Stampa / salva PDF</button>
      ${Sync.can('closeAccounts')
        ? `<button type="button" class="btn btn-primary" data-action="close-account" data-id="${esc(id)}" ${lines.length ? '' : 'disabled'}>Chiudi conto</button>`
        : '<span class="no-perm">Per chiudere il conto chiama il responsabile</span>'}
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
  const [lines, hotel] = await Promise.all([S.accountLines(id), S.getHotel()]);
  const cancelled = lines.filter((l) => l.cancelled);
  setHeader('Conto chiuso', acc.locationName, '#/storico');
  $view.innerHTML = `
    ${receiptHtml(hotel, { name: acc.locationName, guestName: acc.guestName, lines, closedAt: acc.closedAt, ref: M.accountRef(acc.id) })}
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
  if (Sync.isServer()) return renderDataServer(canShare);
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

/** Scheda Dati con il server: stato della sincronizzazione, CSV e copia di sicurezza. */
function renderDataServer(canShare) {
  const st = Sync.getState();
  const manager = Sync.user()?.role === 'manager';
  $view.innerHTML = `
    ${exportBanner(false)}
    <section class="card">
      <h2 class="section-title">Sincronizzazione automatica</h2>
      <p>Ogni modifica viene inviata al server in pochi secondi e arriva sugli altri telefoni. Senza rete puoi continuare a lavorare: le modifiche restano in attesa e partono da sole.</p>
      <p class="muted">Modifiche in attesa: <strong data-testid="pending">${st.pending}</strong>${st.lastSyncAt ? ` · ultimo aggiornamento ${M.formatDateTime(st.lastSyncAt)}` : ''}</p>
      <button type="button" class="btn btn-primary btn-block" data-action="sync-now">Sincronizza ora</button>
    </section>
    <section class="card">
      <h2 class="section-title">Esporta CSV per Excel</h2>
      <p>Conti chiusi nel periodo, una riga per consumazione.</p>
      ${rangeForm('csv', ui.csv.from, ui.csv.to)}
      <button type="button" class="btn btn-secondary btn-block" data-action="csv-data">Esporta CSV</button>
    </section>
    ${manager ? `
    <section class="card">
      <h2 class="section-title">Copia di sicurezza <small>facoltativa</small></h2>
      <p>Il server fa già un backup ogni notte. Qui puoi scaricare una copia dei dati, o importare un file esportato dalla versione senza server (i dati vengono uniti e inviati al server).</p>
      <button type="button" class="btn btn-secondary btn-block" data-action="export-json">Scarica copia (JSON)</button>
      ${canShare ? '<button type="button" class="btn btn-ghost btn-block" data-action="share-json">Condividi copia…</button>' : ''}
      <label class="btn btn-ghost btn-block file-btn">Importa un file
        <input type="file" accept=".json,application/json" data-change="import-file" hidden></label>
    </section>
    ${ui.importResult ? importSummaryHtml(ui.importResult) : ''}` : ''}`;
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
  const server = Sync.isServer();
  const me = Sync.user();
  let staffInfo = null;
  if (server && me?.role === 'manager') {
    try { staffInfo = await Sync.api('GET', 'staff'); } catch (e) { staffInfo = { error: e.message }; }
  }
  const [products, locs, open, stayRates, hotel] = await Promise.all([
    S.listProducts({ includeInactive: true }), S.listLocations({ includeInactive: true }), S.openSummary(), S.listStayRates(), S.getHotel(),
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

  const show = { hotel: Sync.can('editSettings'), prices: Sync.can('editPrices'), rooms: Sync.can('editRooms') };
  $view.innerHTML = `
    ${server ? accountCardHtml(me) : ''}
    ${staffInfo ? staffCardHtml(staffInfo) : ''}
    ${show.hotel ? `<section class="card">
      <h2 class="section-title">Dati struttura <small>intestazione della ricevuta</small></h2>
      <div class="logo-box">
        ${hotel.logo ? `<img src="${esc(hotel.logo)}" alt="Logo attuale">` : '<span class="muted">Nessun logo: in ricevuta compare il nome.</span>'}
      </div>
      <div class="actions">
        <label class="btn btn-secondary file-btn">${hotel.logo ? 'Cambia logo' : 'Carica logo'}
          <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" data-change="hotel-logo" hidden></label>
        ${hotel.logo ? '<button type="button" class="btn btn-ghost danger" data-action="remove-logo">Togli logo</button>' : ''}
      </div>
      <p class="muted">Per la stampa su carta bianca usa un logo scuro su sfondo trasparente o bianco.</p>
      ${[
        ['name', 'Nome struttura', 'es. Albergo Bucaneve'],
        ['place', 'Località', 'es. Malosco (TN)'],
        ['company', 'Ragione sociale', 'es. Rossi Mario & C. s.n.c.'],
        ['address', 'Indirizzo', 'via, numero, CAP, comune'],
        ['vatNumber', 'Partita IVA', ''],
        ['phone', 'Telefono', ''],
        ['email', 'Email', ''],
        ['footer', 'Saluto in fondo alla ricevuta', ''],
      ].map(([k, label, ph]) => `
        <label class="field"><span>${label}</span>
          <input type="${k === 'email' ? 'email' : 'text'}" id="hotel-${k}" data-change="hotel-field" data-field="${k}" value="${esc(hotel[k])}" placeholder="${esc(ph)}" maxlength="120" autocomplete="off"></label>`).join('')}
    </section>` : ''}

    ${server ? '' : `<section class="card">
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
    </section>`}

    ${show.prices ? `<section class="card">
      <h2 class="section-title">Listino <small>${active.length} prodotti</small></h2>
      <button type="button" class="btn btn-primary btn-block" data-action="new-product">+ Nuovo prodotto</button>
      ${listino}
      ${inactive.length ? `<details><summary>Prodotti disattivati (${inactive.length})</summary><ul class="list">${inactive.map((p) => `
        <li><button type="button" class="list-item" data-action="edit-product" data-id="${esc(p.id)}"><div>${esc(p.name)}</div><div class="list-amt">${euro(p.price)}</div></button></li>`).join('')}</ul></details>` : ''}
    </section>` : ''}

    ${show.hotel ? `<section class="card">
      <h2 class="section-title">Voci di soggiorno</h2>
      <p class="muted">Tariffe proposte nel check-out delle camere (modificabili anche lì, conto per conto).</p>
      <ul class="list">${Object.entries(stayRates).map(([type, r]) => r ? `
        <li><button type="button" class="list-item" data-action="edit-stay" data-type="${type}">
          <div>${esc(r.name)}<div class="muted">€ ${M.STAY_TYPES[type].unit} · ${r.vat === 0 ? 'fuori campo IVA' : `IVA ${r.vat}%`}</div></div>
          <div class="list-amt">${r.price ? euro(r.price) : 'al check-out'}</div>
        </button></li>` : '').join('')}</ul>
    </section>` : ''}

    ${show.rooms ? `<section class="card">
      <h2 class="section-title">Camere</h2>
      <p class="muted">Tocca un numero per modificarlo. "Nascondi" toglie la casella dalla griglia (non possibile con un conto aperto).</p>
      <ul class="loc-list">${locs.filter((l) => l.kind === 'camera').map(locRow).join('')}</ul>
      <button type="button" class="btn btn-secondary btn-block" data-action="add-location" data-kind="camera">+ Aggiungi camera</button>
      <h2 class="section-title">Postazioni extra</h2>
      <ul class="loc-list">${locs.filter((l) => l.kind === 'extra').map(locRow).join('')}</ul>
      <button type="button" class="btn btn-secondary btn-block" data-action="add-location" data-kind="extra">+ Aggiungi postazione</button>
    </section>` : ''}

    ${server ? '' : `<section class="card danger-zone">
      <h2 class="section-title">Cancella dati</h2>
      <p>Elimina tutti i dati salvati su questo dispositivo (conti aperti, storico, listino). Esporta prima i dati!</p>
      <button type="button" class="btn btn-danger btn-block" data-action="reset">Cancella tutti i dati locali</button>
    </section>`}

    <p class="muted center">Versione ${APP_VERSION}<br>${server ? 'Dati sincronizzati con il server.' : 'I dati restano solo su questo dispositivo finché non li esporti.'}</p>`;
}

const ROLE_LABEL = { manager: 'Manager', staff: 'Dipendente', admin: 'Amministratore' };

/** "Il mio account": chi è collegato, cambio password, uscita. */
function accountCardHtml(me) {
  return `
    <section class="card">
      <h2 class="section-title">Il mio account</h2>
      <p><strong>${esc(me.name)}</strong> · ${ROLE_LABEL[me.role] || me.role}<br><span class="muted">${esc(me.hotel?.name || '')}${me.email ? ` · ${esc(me.email)}` : ''}</span></p>
      <div class="actions">
        ${me.role !== 'staff' ? '<button type="button" class="btn btn-secondary" data-action="change-password">Cambia password</button>' : ''}
        <button type="button" class="btn btn-ghost danger" data-action="logout">Esci</button>
      </div>
    </section>`;
}

/** Dipendenti (solo manager): elenco, link di accesso, nuovo dipendente. */
function staffCardHtml(info) {
  if (info.error) {
    return `<section class="card"><h2 class="section-title">Dipendenti</h2><p class="muted">${esc(info.error)} La gestione dei dipendenti richiede la connessione.</p></section>`;
  }
  const link = `${location.origin}${location.pathname}#/accedi/${info.code}`;
  ui.staffInfo = info;
  return `
    <section class="card">
      <h2 class="section-title">Dipendenti <small>${info.staff.filter((s) => s.active).length} attivi</small></h2>
      <p>Per entrare dal proprio telefono il dipendente apre il link, sceglie il suo nome e scrive il PIN.</p>
      <div class="share-box">
        <div><span class="muted">Codice struttura</span><strong class="mono" data-testid="hotel-code">${esc(info.code)}</strong></div>
        <input type="text" readonly value="${esc(link)}" id="access-link" aria-label="Link di accesso">
        <div class="actions">
          <button type="button" class="btn btn-small btn-secondary" data-action="copy-link">Copia link</button>
          ${navigator.share ? '<button type="button" class="btn btn-small btn-ghost" data-action="share-link">Condividi…</button>' : ''}
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-block" data-action="new-staff">+ Nuovo dipendente</button>
      <ul class="list staff-list">${info.staff.map((st) => `
        <li><button type="button" class="list-item ${st.active ? '' : 'inactive'}" data-action="edit-staff" data-id="${esc(st.id)}">
          <div>${esc(st.name)}${st.active ? '' : ' <span class="tag">disattivato</span>'}
            <div class="muted">${Object.entries(info.permissions).filter(([k]) => st.perms[k]).map(([, l]) => esc(l)).join(' · ') || 'Solo registrare consumazioni'}</div></div>
          <span aria-hidden="true">›</span>
        </button></li>`).join('') || '<li class="muted">Nessun dipendente: aggiungine uno.</li>'}</ul>
    </section>`;
}

/** Finestra per creare o modificare un dipendente. */
async function staffDialog(id) {
  const info = ui.staffInfo;
  const st = id ? info.staff.find((x) => x.id === id) : null;
  const perms = st ? st.perms : { closeAccounts: true };
  const buttons = [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }];
  if (st) buttons.push({ label: st.active ? 'Disattiva' : 'Riattiva', value: 'toggle', cls: 'btn-ghost danger' });
  buttons.push({ label: 'Salva', value: 'save', cls: 'btn-primary' });
  const r = await openModal({
    title: st ? `Dipendente: ${st.name}` : 'Nuovo dipendente',
    html: `
      <label class="field"><span>Nome (come compare nella schermata di accesso)</span>
        <input name="name" type="text" maxlength="40" autocomplete="off" value="${esc(st?.name || '')}"></label>
      <label class="field"><span>${st ? 'Nuovo PIN (lascia vuoto per non cambiarlo)' : 'PIN (4-6 cifre)'}</span>
        <input name="pin" class="pin-input" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></label>
      <fieldset class="perms"><legend>Può anche:</legend>
        ${Object.entries(info.permissions).map(([k, label]) => `
          <label class="check"><input type="checkbox" name="perm-${k}" ${perms[k] ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
      </fieldset>`,
    buttons,
    validate: (value, d) => {
      if (value === 'toggle') return null;
      if (!d.name.trim()) return 'Inserisci il nome.';
      if ((!st || d.pin) && !/^\d{4,6}$/.test(d.pin)) return 'Il PIN deve avere da 4 a 6 cifre.';
      return null;
    },
  });
  if (!r) return;
  if (r.value === 'toggle') {
    await Sync.api('PATCH', `staff/${st.id}`, { active: !st.active });
    toast(st.active ? `${st.name} disattivato: non può più accedere` : `${st.name} riattivato`);
  } else {
    const body = { name: r.data.name.trim(), perms: Object.fromEntries(Object.keys(info.permissions).map((k) => [k, r.data[`perm-${k}`] === 'on'])) };
    if (r.data.pin) body.pin = r.data.pin;
    if (st) await Sync.api('PATCH', `staff/${st.id}`, body);
    else await Sync.api('POST', 'staff', body);
    toast(st ? 'Dipendente aggiornato' : `${body.name} aggiunto`);
  }
  render();
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
  const hotel = await S.getHotel();
  return {
    email: email || '',
    subject: `Riepilogo ${name} – ${hotel.name}`,
    text: M.buildTextSummary({ hotel: M.hotelTitle(hotel), name, guestName, lines, closedAt }),
  };
}

// ---------------------------------------------------------------------------
// Accesso (solo con il server)
// ---------------------------------------------------------------------------

/** Indirizzo diretto per amministratore e manager: #/gestione (solo email + password). */
function renderLoginResp() {
  ui.login.tab = 'manager';
  return renderLogin(null, { respOnly: true });
}

async function renderLogin(codeParam, { respOnly = false } = {}) {
  setHeader(respOnly ? 'Accesso responsabili' : 'Accesso', respOnly ? 'Amministratore e manager' : 'Registro consumazioni');
  const L = ui.login;
  if (codeParam && codeParam !== L.code) Object.assign(L, { tab: 'staff', code: codeParam, staff: null, selected: null });
  // Arrivati dal link del manager: si mostrano subito i nomi della struttura
  if (codeParam && L.tab === 'staff' && !L.staff) {
    try {
      const r = await Sync.api('GET', `hotel/${encodeURIComponent(codeParam)}/staff`);
      Object.assign(L, { hotelName: r.hotel.name, staff: r.staff });
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }
  const tabs = `
    <div class="seg" role="tablist">
      <button type="button" role="tab" class="${L.tab === 'staff' ? 'active' : ''}" aria-selected="${L.tab === 'staff'}" data-action="login-tab" data-tab="staff">Dipendente</button>
      <button type="button" role="tab" class="${L.tab === 'manager' ? 'active' : ''}" aria-selected="${L.tab === 'manager'}" data-action="login-tab" data-tab="manager">Responsabile</button>
    </div>`;
  let body;
  if (L.tab === 'manager') {
    body = `
      <form data-submit="login-manager" class="login-form" novalidate>
        <label class="field"><span>Email</span><input name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="off" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit" class="btn btn-primary btn-block">Accedi</button>
      </form>`;
  } else if (!L.staff) {
    body = `
      <form data-submit="login-code" class="login-form" novalidate>
        <label class="field"><span>Codice struttura <small>(te lo dà il responsabile)</small></span>
          <input name="code" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(L.code)}" placeholder="es. bucaneve" required></label>
        <button type="submit" class="btn btn-primary btn-block">Avanti</button>
      </form>`;
  } else if (!L.selected) {
    body = `
      <p class="login-hotel">${esc(L.hotelName)}</p>
      <p class="muted">Chi sei?</p>
      <div class="name-grid">${L.staff.map((st) => `<button type="button" class="btn btn-ghost name-btn" data-action="login-pick" data-id="${esc(st.id)}">${esc(st.name)}</button>`).join('') || '<p class="muted">Nessun dipendente registrato: chiedi al responsabile.</p>'}</div>
      <button type="button" class="btn btn-small btn-ghost" data-action="login-back">Cambia struttura</button>`;
  } else {
    const who = L.staff.find((x) => x.id === L.selected);
    body = `
      <p class="login-hotel">${esc(L.hotelName)}</p>
      <form data-submit="login-pin" class="login-form" novalidate>
        <label class="field"><span>PIN di <strong>${esc(who?.name || '')}</strong></span>
          <input name="pin" class="pin-input" type="password" inputmode="numeric" autocomplete="current-password" maxlength="6" required></label>
        <button type="submit" class="btn btn-primary btn-block">Entra</button>
      </form>
      <button type="button" class="btn btn-small btn-ghost" data-action="login-unpick">Non sono ${esc(who?.name || '')}</button>`;
  }
  $view.innerHTML = `<section class="card login-card">${respOnly ? '' : tabs}${body}</section>`;
  $view.querySelector('input')?.focus();
}

/** Dopo l'accesso: prepara il dispositivo e scarica i dati della struttura. */
async function afterLogin(user) {
  await Sync.setUser(user);
  if (user.mustChange) { go('#/password'); return; }
  ui.tempPassword = null;
  if (user.role === 'admin') { ui.pendingToast = [`Ciao ${user.name}!`]; go('#/admin'); return; }
  $view.innerHTML = '<p class="loading">Scarico i dati della struttura…</p>';
  await S.useServerIdentity(user);
  await Sync.onLogin(user, { resetLocal: S.resetSyncedData, seedIfEmpty: S.seedIfEmpty });
  Object.assign(ui.login, { staff: null, selected: null });
  ui.unlockedUntil = 0;
  ui.pendingToast = [`Ciao ${user.name}!`];
  go('#/');
}

const submits = {
  'login-code': async (form) => {
    const code = form.code.value.trim().toLowerCase();
    if (!code) { toast('Scrivi il codice della struttura.', { kind: 'error' }); return; }
    const r = await Sync.api('GET', `hotel/${encodeURIComponent(code)}/staff`);
    Object.assign(ui.login, { code, hotelName: r.hotel.name, staff: r.staff, selected: null });
    render();
  },
  'login-pin': async (form) => {
    const { user } = await Sync.api('POST', 'login-pin', { code: ui.login.code, userId: ui.login.selected, pin: form.pin.value });
    await afterLogin(user);
  },
  'login-manager': async (form) => {
    const { user } = await Sync.api('POST', 'login', { email: form.email.value.trim(), password: form.password.value });
    ui.tempPassword = form.password.value; // solo in memoria, per il cambio della password provvisoria
    await afterLogin(user);
  },
  'force-password': async (form) => {
    const d = Object.fromEntries(new FormData(form));
    if (d.next.length < 10) throw new Error('La nuova password deve avere almeno 10 caratteri.');
    if (d.next !== d.next2) throw new Error('Le due password non coincidono.');
    const res = await Sync.api('POST', 'password', { current: ui.tempPassword || d.current, next: d.next });
    toast('Password salvata');
    await afterLogin(res.user);
  },
};

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-submit]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('[type="submit"]');
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try { await submits[form.dataset.submit](form); } catch (err) {
    handleError(err);
    if (form.pin) form.pin.value = '';
  } finally { if (btn && btn.isConnected) btn.disabled = false; }
});

/** Primo accesso con password provvisoria: bisogna sceglierne una personale. */
function renderForcePassword() {
  const u = Sync.user();
  setHeader('Scegli la tua password', u?.name || '');
  $view.innerHTML = `
    <form class="card login-card" data-submit="force-password" novalidate>
      <h2 class="section-title">Benvenuto${u ? `, ${esc(u.name)}` : ''}!</h2>
      <p>Stai usando una password provvisoria. Scegline una personale (almeno 10 caratteri): solo tu la conoscerai.</p>
      ${ui.tempPassword ? '' : '<label class="field"><span>Password provvisoria</span><input name="current" type="password" autocomplete="current-password"></label>'}
      <label class="field"><span>Nuova password</span><input name="next" type="password" autocomplete="new-password" minlength="10"></label>
      <label class="field"><span>Ripeti la nuova password</span><input name="next2" type="password" autocomplete="new-password"></label>
      <button type="submit" class="btn btn-primary btn-block">Salva e continua</button>
      <button type="button" class="btn btn-ghost btn-block" data-action="logout-now">Esci</button>
    </form>`;
  $view.querySelector('input')?.focus();
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

  decrement: async (el) => {
    if (Number(el.dataset.qty) <= 1) return actions['cancel-line'](el); // da 1 a 0 = annulla, con conferma
    await S.decrementLine(el.dataset.id);
    render();
  },

  increment: async (el) => { await S.incrementLine(el.dataset.id); render(); },

  'set-qty': async (el) => {
    const r = await openModal({
      title: 'Quantità',
      html: `<p>Scrivi la quantità giusta. Con 0 la riga viene annullata (resta nello storico).</p>
        <input class="pin-input" name="qty" type="number" inputmode="numeric" min="0" max="999" value="${esc(el.dataset.qty)}" aria-label="Quantità">`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Salva', value: 'ok', cls: 'btn-primary' }],
      validate: (_v, d) => (/^\d{1,3}$/.test(d.qty.trim()) ? null : 'Scrivi un numero da 0 a 999.'),
    });
    if (!r) return;
    const qty = Number(r.data.qty);
    const line = await S.setLineQty(el.dataset.id, qty);
    if (line) toast(qty === 0 ? `${line.name}: riga annullata` : `${line.name}: quantità ${qty}`);
    render();
  },

  'remove-one': async (el) => {
    const line = await S.removeOneOfProduct(currentParam(), el.dataset.id);
    if (!line) return;
    if (navigator.vibrate) navigator.vibrate(15);
    await render();
    toast(line.cancelled ? `${line.name}: riga annullata` : `${line.name}: ora ×${line.qty}`);
  },

  'remove-logo': async () => {
    if (!(await confirmDialog('Togliere il logo?', 'In ricevuta comparirà il nome della struttura.', 'Togli logo', true))) return;
    await S.saveHotel({ logo: '' });
    render();
  },

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

  'logout-now': async () => {
    await Sync.logout({ resetLocal: S.resetSyncedData });
    ui.tempPassword = null;
    go('#/accedi');
  },

  'login-tab': (el) => { ui.login.tab = el.dataset.tab; render(); },
  'login-pick': (el) => { ui.login.selected = el.dataset.id; render(); },
  'login-unpick': () => { ui.login.selected = null; render(); },
  'login-back': () => { Object.assign(ui.login, { staff: null, selected: null }); render(); },

  'sync-now': async () => { await Sync.syncNow(); const st = Sync.getState(); toast(st.status === 'ok' ? 'Dati aggiornati' : syncStatus().text, { kind: st.status === 'ok' ? '' : 'error' }); render(); },

  logout: async () => {
    const { pending } = Sync.getState();
    const warn = pending ? `<br><strong>Attenzione:</strong> ${pending} modifiche non sono ancora arrivate al server. Prova prima a sincronizzare con la rete attiva, altrimenti andranno perse.` : '';
    if (!(await confirmDialog('Uscire?', `I dati della struttura verranno tolti da questo telefono (restano sul server).${warn}`, 'Esci', !!pending))) return;
    await Sync.logout({ resetLocal: S.resetSyncedData });
    go('#/accedi');
  },

  'change-password': async () => {
    const r = await openModal({
      title: 'Cambia password',
      html: `
        <label class="field"><span>Password attuale</span><input name="current" type="password" autocomplete="current-password"></label>
        <label class="field"><span>Nuova password (almeno 10 caratteri)</span><input name="next" type="password" autocomplete="new-password"></label>
        <label class="field"><span>Ripeti la nuova password</span><input name="next2" type="password" autocomplete="new-password"></label>`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Salva', value: 'ok', cls: 'btn-primary' }],
      validate: async (_v, d) => {
        if (d.next.length < 10) return 'La nuova password deve avere almeno 10 caratteri.';
        if (d.next !== d.next2) return 'Le due password non coincidono.';
        try { await Sync.api('POST', 'password', { current: d.current, next: d.next }); } catch (e) { return e.message; }
        return null;
      },
    });
    if (r) toast('Password cambiata');
  },

  'new-staff': () => staffDialog(null),
  'edit-staff': (el) => staffDialog(el.dataset.id),

  'copy-link': async () => {
    const input = document.getElementById('access-link');
    try { await navigator.clipboard.writeText(input.value); toast('Link copiato'); } catch { input.select(); toast('Seleziona e copia il link'); }
  },
  'share-link': async () => {
    try { await navigator.share({ title: 'Accesso registro consumazioni', text: 'Apri il link, scegli il tuo nome e inserisci il PIN:', url: document.getElementById('access-link').value }); } catch (e) { if (e.name !== 'AbortError') throw e; }
  },

  'apply-update': () => {
    updateRequested = true;
    waitingWorker?.postMessage('SKIP_WAITING');
  },
};

/** Gestori dei campi modificabili (evento "change"). */
const changes = {
  'hotel-field': async (el) => {
    await S.saveHotel({ [el.dataset.field]: el.value });
    toast('Dati struttura salvati');
  },
  'hotel-logo': async (el) => {
    const file = el.files && el.files[0];
    el.value = '';
    if (!file) return;
    await S.saveHotel({ logo: await imageToDataUrl(file) });
    toast('Logo salvato');
    render();
  },
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
  // Gli errori "previsti" del server (PIN sbagliato, permessi…) sono solo messaggi per l'utente
  if (!(e instanceof Sync.ApiError && e.status >= 400 && e.status < 500)) console.error(e);
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

Object.assign(actions, Admin.actions);
Object.assign(changes, Admin.changes);
Object.assign(submits, Admin.submits);

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
  [/^\/accedi(?:\/([a-z0-9-]+))?$/, renderLogin, 'accedi'],
  [/^\/gestione$/, renderLoginResp, 'accedi'],
  [/^\/password$/, renderForcePassword, 'password'],
  [/^\/admin$/, () => Admin.renderList(), 'admin'],
  [/^\/admin\/nuova$/, () => Admin.renderNew(), 'admin'],
  [/^\/admin\/h\/([0-9a-f-]{36})$/, (id) => Admin.renderHotel(id), 'admin'],
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
  // Con il server: senza accesso si va alla schermata di login, e viceversa
  const isLogin = path.startsWith('/accedi') || path === '/gestione';
  if (Sync.isServer() && !Sync.user() && !isLogin) { location.hash = '#/accedi'; return; }
  if (isLogin && (!Sync.isServer() || Sync.user())) { location.hash = '#/'; return; }
  const u = Sync.user();
  if (u?.mustChange && path !== '/password') { location.hash = '#/password'; return; }
  if (!u?.mustChange && path === '/password') { location.hash = '#/'; return; }
  const isAdminPath = path.startsWith('/admin');
  if (u?.role === 'admin' && !u.mustChange && !isAdminPath) { location.hash = '#/admin'; return; }
  if (isAdminPath && u?.role !== 'admin') { location.hash = '#/'; return; }
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

/**
 * Arrivano dati da altri dispositivi: ridisegna la schermata, ma non mentre
 * l'utente sta scrivendo in un campo o ha una finestra aperta.
 */
function isBusyTyping() {
  const a = document.activeElement;
  return !!document.querySelector('#modal-root .modal') || !!(a && a.closest('#view') && a.matches('input, select, textarea'));
}
function renderWhenIdle() {
  if (isBusyTyping()) { ui.pendingRender = true; return; }
  ui.pendingRender = false;
  render();
}
document.addEventListener('focusout', () => setTimeout(() => { if (ui.pendingRender) renderWhenIdle(); }, 200));
setInterval(() => { if (ui.pendingRender) renderWhenIdle(); }, 2000);

Sync.on('status', refreshSyncIndicators);
Sync.on('data', renderWhenIdle);
Sync.on('logout', () => { ui.pendingToast = ['Sessione scaduta: accedi di nuovo.', { kind: 'error' }]; go('#/accedi'); });

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
  await Sync.detect();
  if (Sync.isServer()) {
    Sync.start();
    if (Sync.user()?.hotel) await S.useServerIdentity(Sync.user());
  }
  await render();
  // Con il server: scarica le novità (e, se il dispositivo era vuoto, tutti i dati)
  const u = Sync.user();
  if (Sync.isServer() && u?.hotel && !u.mustChange) Sync.onLogin(u, { resetLocal: S.resetSyncedData, seedIfEmpty: S.seedIfEmpty });
  registerServiceWorker();
}

Admin.init({
  view: $view, esc, toast, openModal, setHeader, go, render, imageToDataUrl, accountCardHtml,
  api: Sync.api, user: Sync.user,
});

start();
