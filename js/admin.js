/**
 * admin.js — Pannello di gestione dell'amministratore del servizio.
 *
 * Schermate:
 *   #/admin            elenco strutture, stato degli abbonamenti
 *   #/admin/nuova      nuova struttura + manager con password provvisoria
 *   #/admin/h/<id>     dettaglio: dati, abbonamento, logo, manager, accesso, stato
 *
 * Usa le API /api/admin/… (server/admin.js). Le funzioni di interfaccia
 * condivise (finestre, avvisi, intestazione…) arrivano da app.js con init().
 */

import * as M from './model.js';

let H; // aiuti dall'app: { view, esc, toast, openModal, setHeader, go, render, api, imageToDataUrl, accountCardHtml, user }

export function init(helpers) {
  H = helpers;
}

const STATUS = {
  attivo: ['Attivo', 'ok'],
  'in-scadenza': ['In scadenza', 'warn'],
  scaduto: ['Scaduto', 'bad'],
  'senza-scadenza': ['Senza scadenza', 'muted'],
  disattivata: ['Disattivata', 'off'],
};
const chip = (status) => `<span class="status-chip ${STATUS[status]?.[1] || ''}">${STATUS[status]?.[0] || status}</span>`;

const todayKey = () => M.dateKey(Date.now());
const fmtDay = (key) => (key ? key.split('-').reverse().join('/') : '—');

/** Stessa data dell'anno dopo, partendo dalla scadenza (o da oggi se già scaduta). */
export function plusOneYear(fromKey) {
  const base = fromKey && fromKey >= todayKey() ? fromKey : todayKey();
  const [y, m, d] = base.split('-').map(Number);
  return M.dateKey(new Date(y + 1, m - 1, d).getTime());
}

const slug = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/^(hotel|albergo|garni|residence)\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const appUrl = () => `${location.origin}${location.pathname}`;

/** Messaggio pronto da mandare con le credenziali provvisorie (manager o amministratore). */
function welcomeText(c, hotelName) {
  if (!c.code) {
    return [
      'Ciao! Ecco il tuo accesso al pannello di gestione di Stella.',
      '',
      `Indirizzo: ${appUrl()}#/gestione`,
      `Email: ${c.email}`,
      `Password provvisoria: ${c.password}`,
      '',
      'Al primo accesso ti verrà chiesto di scegliere una password personale.',
    ].join('\n');
  }
  return [
    `Ciao! Ecco l'accesso al registro consumazioni di ${hotelName}.`,
    '',
    `Indirizzo: ${appUrl()}#/gestione`,
    `Email: ${c.email}`,
    `Password provvisoria: ${c.password}`,
    '',
    'Al primo accesso ti verrà chiesto di scegliere una password personale.',
    `Per i dipendenti: link ${appUrl()}#/accedi/${c.code} (li crei tu in Impostazioni → Dipendenti).`,
  ].join('\n');
}

async function showCredentials(c, hotelName) {
  const text = welcomeText(c, hotelName);
  await H.openModal({
    title: 'Credenziali provvisorie',
    html: `
      <p>Vengono mostrate <strong>solo adesso</strong>. Copiale o mandale subito al manager.</p>
      <dl class="cred">
        <div><dt>Email</dt><dd class="mono">${H.esc(c.email)}</dd></div>
        <div><dt>Password provvisoria</dt><dd class="mono" data-testid="temp-password">${H.esc(c.password)}</dd></div>
      </dl>
      <textarea class="cred-text" id="cred-text" readonly rows="8">${H.esc(text)}</textarea>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-cred="copy">Copia messaggio</button>
        ${navigator.share ? '<button type="button" class="btn btn-ghost" data-cred="share">Condividi…</button>' : ''}
      </div>`,
    buttons: [{ label: 'Fatto', value: 'ok', cls: 'btn-primary' }],
    onOpen: (form) => {
      form.querySelector('[data-cred="copy"]').onclick = async () => {
        try { await navigator.clipboard.writeText(text); H.toast('Messaggio copiato'); } catch { form.querySelector('#cred-text').select(); H.toast('Seleziona e copia il testo'); }
      };
      form.querySelector('[data-cred="share"]')?.addEventListener('click', () => navigator.share({ title: 'Accesso Stella', text }).catch(() => {}));
    },
  });
}

// ---------------------------------------------------------------------------
// Elenco strutture
// ---------------------------------------------------------------------------

export async function renderList() {
  const me = H.user();
  H.setHeader('Pannello di gestione', me.name);
  const [{ hotels }, { admins }] = await Promise.all([H.api('GET', 'admin/hotels'), H.api('GET', 'admin/admins')]);
  const count = (st) => hotels.filter((h) => h.status === st).length;
  const sorted = hotels.slice().sort((a, b) => {
    const rank = { scaduto: 0, 'in-scadenza': 1, attivo: 2, 'senza-scadenza': 3, disattivata: 4 };
    return (rank[a.status] - rank[b.status]) || (a.subEnd || '9').localeCompare(b.subEnd || '9') || a.name.localeCompare(b.name, 'it');
  });
  H.view.innerHTML = `
    <div class="stat-row">
      <div class="stat"><span class="big">${hotels.filter((h) => h.active).length}</span><span>strutture attive</span></div>
      <div class="stat warn"><span class="big">${count('in-scadenza')}</span><span>in scadenza (30 gg)</span></div>
      <div class="stat bad"><span class="big">${count('scaduto')}</span><span>scadute</span></div>
    </div>
    <a class="btn btn-primary btn-block" href="#/admin/nuova">+ Nuova struttura</a>
    <h2 class="section-title">Strutture</h2>
    <ul class="list">${sorted.map((h) => `
      <li><a class="list-item hotel-item" href="#/admin/h/${H.esc(h.id)}">
        <div>
          <strong>${H.esc(h.name)}</strong> ${chip(h.status)}
          <div class="muted">codice ${H.esc(h.code)} · scadenza ${fmtDay(h.subEnd)}${h.priceCents ? ` · ${M.formatEuro(h.priceCents)}${h.plan ? ` ${H.esc(h.plan.toLowerCase())}` : ''}` : ''}</div>
          <div class="muted">${h.managers.map((m) => H.esc(m.email)).join(', ') || 'nessun manager'} · ${h.staffCount} dipendenti${h.lastActivity ? ` · ultima attività ${M.formatDate(h.lastActivity)}` : ''}</div>
        </div>
        <span aria-hidden="true">›</span>
      </a></li>`).join('') || '<li class="empty">Nessuna struttura: creane una.</li>'}</ul>
    ${H.accountCardHtml(me)}
    <section class="card">
      <h2 class="section-title">Amministratori <small>accesso al pannello</small></h2>
      <ul class="list">${admins.map((a) => `
        <li class="list-item static">
          <div><strong>${H.esc(a.name)}</strong>${a.me ? ' <span class="tag">tu</span>' : ''}${a.mustChange ? ' <span class="tag">password provvisoria</span>' : ''}<div class="muted">${H.esc(a.email)}</div></div>
          <span class="row-actions">
            <button type="button" class="btn btn-small btn-ghost" data-action="admin-edit-user" data-id="${H.esc(a.id)}" data-name="${H.esc(a.name)}" data-email="${H.esc(a.email)}" data-hotel="">Modifica</button>
            ${a.me ? '' : `<button type="button" class="btn btn-small btn-ghost" data-action="admin-reset" data-id="${H.esc(a.id)}" data-hotel="">Nuova password</button>`}
          </span>
        </li>`).join('')}</ul>
      <button type="button" class="btn btn-secondary btn-block" data-action="admin-new-admin">+ Nuovo amministratore</button>
    </section>`;
}

// ---------------------------------------------------------------------------
// Nuova struttura
// ---------------------------------------------------------------------------

export function renderNew() {
  H.setHeader('Nuova struttura', 'Pannello di gestione', '#/admin');
  const start = todayKey();
  H.view.innerHTML = `
    <form class="card admin-form" data-submit="admin-create" novalidate>
      <h2 class="section-title">Struttura</h2>
      <label class="field"><span>Nome</span><input name="name" id="new-name" required maxlength="80" placeholder="es. Albergo Bucaneve" autocomplete="off"></label>
      <label class="field"><span>Codice per i dipendenti <small>(lettere minuscole, numeri, trattini)</small></span>
        <input name="code" id="new-code" required maxlength="40" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="es. bucaneve"></label>
      <h2 class="section-title">Manager</h2>
      <label class="field"><span>Nome</span><input name="managerName" required maxlength="60" autocomplete="off"></label>
      <label class="field"><span>Email (per accedere)</span><input name="managerEmail" type="email" inputmode="email" required autocapitalize="off" autocomplete="off"></label>
      <h2 class="section-title">Abbonamento</h2>
      <div class="two">
        <label class="field"><span>Piano</span><input name="plan" maxlength="60" value="Annuale"></label>
        <label class="field"><span>Importo (€)</span><input name="price" inputmode="decimal" placeholder="0,00"></label>
        <label class="field"><span>Inizio</span><input name="subStart" type="date" value="${start}"></label>
        <label class="field"><span>Scadenza</span><input name="subEnd" type="date" value="${plusOneYear(start)}"></label>
      </div>
      <h2 class="section-title">Contatti <small>facoltativi</small></h2>
      <label class="field"><span>Referente</span><input name="contactName" maxlength="80"></label>
      <div class="two">
        <label class="field"><span>Email</span><input name="contactEmail" type="email" maxlength="200"></label>
        <label class="field"><span>Telefono</span><input name="contactPhone" type="tel" maxlength="40"></label>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Crea struttura e credenziali</button>
    </form>`;
  // Codice proposto dal nome, finché non lo si modifica a mano
  const name = H.view.querySelector('#new-name');
  const code = H.view.querySelector('#new-code');
  name.addEventListener('input', () => { if (!code.dataset.touched) code.value = slug(name.value); });
  code.addEventListener('input', () => { code.dataset.touched = '1'; });
}

function priceFrom(text) {
  if (!String(text || '').trim()) return 0;
  const cents = M.parseEuro(text);
  if (Number.isNaN(cents)) throw new Error('Importo non valido (es. 299,00).');
  return cents;
}

// ---------------------------------------------------------------------------
// Dettaglio struttura
// ---------------------------------------------------------------------------

export async function renderHotel(id) {
  const { hotel: h } = await H.api('GET', `admin/hotels/${id}`);
  H.setHeader(h.name, 'Pannello di gestione', '#/admin');
  const staffLink = `${appUrl()}#/accedi/${h.code}`;
  H.view.innerHTML = `
    <section class="card">
      <div class="hotel-head"><div><h2 class="section-title">${H.esc(h.name)}</h2><span class="muted">codice <strong class="mono">${H.esc(h.code)}</strong> · creata il ${M.formatDate(h.createdAt)}</span></div>${chip(h.status)}</div>
      <p class="muted">${h.staffCount} dipendenti attivi${h.lastActivity ? ` · ultima attività ${M.formatDateTime(h.lastActivity)}` : ' · nessuna attività'}</p>
    </section>

    <form class="card admin-form" data-submit="admin-sub" data-id="${H.esc(h.id)}" novalidate>
      <h2 class="section-title">Abbonamento</h2>
      <div class="two">
        <label class="field"><span>Piano</span><input name="plan" maxlength="60" value="${H.esc(h.plan)}"></label>
        <label class="field"><span>Importo (€)</span><input name="price" inputmode="decimal" value="${h.priceCents ? H.esc(M.formatDecimal(h.priceCents)) : ''}" placeholder="0,00"></label>
        <label class="field"><span>Inizio</span><input name="subStart" type="date" value="${H.esc(h.subStart)}"></label>
        <label class="field"><span>Scadenza</span><input name="subEnd" id="sub-end" type="date" value="${H.esc(h.subEnd)}"></label>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-ghost" data-action="admin-plus-year">Rinnova: +1 anno</button>
        <button type="submit" class="btn btn-primary">Salva abbonamento</button>
      </div>
    </form>

    <section class="card">
      <h2 class="section-title">Manager <small>accesso con email e password</small></h2>
      <ul class="list">${h.managers.map((m) => `
        <li class="list-item static">
          <div><strong>${H.esc(m.name)}</strong>${m.mustChange ? ' <span class="tag">password provvisoria</span>' : ''}<div class="muted">${H.esc(m.email)}</div></div>
          <span class="row-actions">
            <button type="button" class="btn btn-small btn-ghost" data-action="admin-edit-user" data-id="${H.esc(m.id)}" data-name="${H.esc(m.name)}" data-email="${H.esc(m.email)}" data-hotel="${H.esc(h.name)}">Modifica</button>
            <button type="button" class="btn btn-small btn-ghost" data-action="admin-reset" data-id="${H.esc(m.id)}" data-hotel="${H.esc(h.name)}">Nuova password</button>
          </span>
        </li>`).join('') || '<li class="muted">Nessun manager.</li>'}</ul>
      <button type="button" class="btn btn-secondary btn-block" data-action="admin-add-manager" data-id="${H.esc(h.id)}" data-hotel="${H.esc(h.name)}">+ Aggiungi manager</button>
      <p class="muted">Link per i dipendenti: <span class="mono break">${H.esc(staffLink)}</span></p>
    </section>

    <section class="card">
      <h2 class="section-title">Logo <small>compare sulle ricevute</small></h2>
      <div class="logo-box">${h.logo ? `<img src="${H.esc(h.logo)}" alt="Logo di ${H.esc(h.name)}">` : '<span class="muted">Nessun logo</span>'}</div>
      <div class="actions">
        <label class="btn btn-secondary file-btn">${h.logo ? 'Cambia logo' : 'Carica logo'}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-change="admin-logo" data-id="${H.esc(h.id)}" hidden></label>
        ${h.logo ? `<button type="button" class="btn btn-ghost danger" data-action="admin-remove-logo" data-id="${H.esc(h.id)}">Togli logo</button>` : ''}
      </div>
    </section>

    <form class="card admin-form" data-submit="admin-info" data-id="${H.esc(h.id)}" novalidate>
      <h2 class="section-title">Dati e contatti</h2>
      <label class="field"><span>Nome struttura</span><input name="name" maxlength="80" value="${H.esc(h.name)}" required></label>
      <label class="field"><span>Referente</span><input name="contactName" maxlength="80" value="${H.esc(h.contactName)}"></label>
      <div class="two">
        <label class="field"><span>Email</span><input name="contactEmail" type="email" maxlength="200" value="${H.esc(h.contactEmail)}"></label>
        <label class="field"><span>Telefono</span><input name="contactPhone" type="tel" maxlength="40" value="${H.esc(h.contactPhone)}"></label>
      </div>
      <label class="field"><span>Note (visibili solo a te)</span><textarea name="notes" rows="3" maxlength="2000">${H.esc(h.notes)}</textarea></label>
      <button type="submit" class="btn btn-primary btn-block">Salva dati</button>
    </form>

    <section class="card danger-zone">
      <h2 class="section-title">Stato</h2>
      <p>${h.active ? 'Disattivando la struttura, manager e dipendenti escono e non possono più accedere. I dati restano conservati.' : 'La struttura è disattivata: nessuno può accedere. Riattivandola tutto torna come prima.'}</p>
      <button type="button" class="btn ${h.active ? 'btn-danger' : 'btn-primary'} btn-block" data-action="admin-toggle" data-id="${H.esc(h.id)}" data-active="${h.active ? '1' : ''}">${h.active ? 'Disattiva struttura' : 'Riattiva struttura'}</button>
    </section>`;
}

// ---------------------------------------------------------------------------
// Moduli e azioni (registrati in app.js)
// ---------------------------------------------------------------------------

const fd = (form) => Object.fromEntries(new FormData(form));

export const submits = {
  'admin-create': async (form) => {
    const d = fd(form);
    const res = await H.api('POST', 'admin/hotels', {
      name: d.name, code: d.code.trim().toLowerCase(), managerName: d.managerName, managerEmail: d.managerEmail,
      plan: d.plan, priceCents: priceFrom(d.price), subStart: d.subStart, subEnd: d.subEnd,
      contactName: d.contactName, contactEmail: d.contactEmail, contactPhone: d.contactPhone,
    });
    await showCredentials(res.credentials, res.hotel.name);
    H.go(`#/admin/h/${res.hotel.id}`);
  },
  'admin-sub': async (form) => {
    const d = fd(form);
    await H.api('PATCH', `admin/hotels/${form.dataset.id}`, { plan: d.plan, priceCents: priceFrom(d.price), subStart: d.subStart, subEnd: d.subEnd });
    H.toast('Abbonamento salvato');
    H.render();
  },
  'admin-info': async (form) => {
    const d = fd(form);
    await H.api('PATCH', `admin/hotels/${form.dataset.id}`, { name: d.name, contactName: d.contactName, contactEmail: d.contactEmail, contactPhone: d.contactPhone, notes: d.notes });
    H.toast('Dati salvati');
    H.render();
  },
};

export const actions = {
  'admin-plus-year': () => {
    const input = document.getElementById('sub-end');
    input.value = plusOneYear(input.value);
    H.toast(`Nuova scadenza ${fmtDay(input.value)}: ricordati di salvare`);
  },
  'admin-reset': async (el) => {
    const ok = await H.openModal({
      title: 'Nuova password provvisoria?',
      html: '<p>La password attuale smette di funzionare e il manager esce da tutti i dispositivi. Al prossimo accesso dovrà sceglierne una nuova.</p>',
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Genera', value: 'ok', cls: 'btn-primary' }],
    });
    if (!ok) return;
    const res = await H.api('POST', `admin/users/${el.dataset.id}/reset`, {});
    await showCredentials(res.credentials, el.dataset.hotel);
    H.render();
  },
  'admin-add-manager': async (el) => {
    const r = await H.openModal({
      title: 'Nuovo manager',
      html: `
        <label class="field"><span>Nome</span><input name="name" maxlength="60" autocomplete="off"></label>
        <label class="field"><span>Email</span><input name="email" type="email" inputmode="email" autocapitalize="off" autocomplete="off"></label>`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Crea', value: 'ok', cls: 'btn-primary' }],
      validate: (_v, d) => (!d.name.trim() ? 'Inserisci il nome.' : !M.isEmail(d.email) ? 'Email non valida.' : null),
    });
    if (!r) return;
    const res = await H.api('POST', `admin/hotels/${el.dataset.id}/managers`, { name: r.data.name, email: r.data.email });
    await showCredentials(res.credentials, el.dataset.hotel);
    H.render();
  },
  'admin-edit-user': async (el) => {
    const r = await H.openModal({
      title: 'Modifica accesso',
      html: `
        <label class="field"><span>Nome</span><input name="name" maxlength="60" autocomplete="off" value="${H.esc(el.dataset.name)}"></label>
        <label class="field"><span>Email di accesso</span><input name="email" type="email" inputmode="email" autocapitalize="off" autocomplete="off" value="${H.esc(el.dataset.email)}"></label>
        <label class="check"><input type="checkbox" name="newpass"> Genera anche una nuova password provvisoria (da mandare al nuovo indirizzo)</label>`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Salva', value: 'ok', cls: 'btn-primary' }],
      validate: (_v, d) => (!d.name.trim() ? 'Inserisci il nome.' : !M.isEmail(d.email) ? 'Email non valida.' : null),
    });
    if (!r) return;
    await H.api('PATCH', `admin/users/${el.dataset.id}`, { name: r.data.name, email: r.data.email });
    H.toast('Accesso aggiornato');
    if (r.data.newpass === 'on') {
      const res = await H.api('POST', `admin/users/${el.dataset.id}/reset`, {});
      await showCredentials(res.credentials, el.dataset.hotel);
    }
    H.render();
  },
  'admin-new-admin': async () => {
    const r = await H.openModal({
      title: 'Nuovo amministratore',
      html: `<p>Avrà accesso completo al pannello: tutte le strutture e gli abbonamenti.</p>
        <label class="field"><span>Nome</span><input name="name" maxlength="60" autocomplete="off"></label>
        <label class="field"><span>Email</span><input name="email" type="email" inputmode="email" autocapitalize="off" autocomplete="off"></label>`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: 'Crea', value: 'ok', cls: 'btn-primary' }],
      validate: (_v, d) => (!d.name.trim() ? 'Inserisci il nome.' : !M.isEmail(d.email) ? 'Email non valida.' : null),
    });
    if (!r) return;
    const res = await H.api('POST', 'admin/admins', { name: r.data.name, email: r.data.email });
    await showCredentials(res.credentials, '');
    H.render();
  },
  'admin-remove-logo': async (el) => {
    await H.api('POST', `admin/hotels/${el.dataset.id}/logo`, { logo: '' });
    H.toast('Logo tolto');
    H.render();
  },
  'admin-toggle': async (el) => {
    const active = !!el.dataset.active;
    const ok = await H.openModal({
      title: active ? 'Disattivare la struttura?' : 'Riattivare la struttura?',
      html: `<p>${active ? 'Manager e dipendenti verranno fatti uscire e non potranno accedere finché non la riattivi.' : 'Manager e dipendenti potranno accedere di nuovo.'}</p>`,
      buttons: [{ label: 'Annulla', value: 'cancel', cls: 'btn-ghost' }, { label: active ? 'Disattiva' : 'Riattiva', value: 'ok', cls: active ? 'btn-danger' : 'btn-primary' }],
    });
    if (!ok) return;
    await H.api('PATCH', `admin/hotels/${el.dataset.id}`, { active: !active });
    H.toast(active ? 'Struttura disattivata' : 'Struttura riattivata');
    H.render();
  },
};

export const changes = {
  'admin-logo': async (el) => {
    const file = el.files && el.files[0];
    el.value = '';
    if (!file) return;
    await H.api('POST', `admin/hotels/${el.dataset.id}/logo`, { logo: await H.imageToDataUrl(file) });
    H.toast('Logo salvato: comparirà sulle ricevute della struttura');
    H.render();
  },
};
