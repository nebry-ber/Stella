# Bucaneve · Consumazioni

App web (PWA) per registrare le consumazioni addebitate alle camere dell'**Hotel Bucaneve di Ronzone (TN)**.

È un **prototipo** da far provare al personale. Funziona da browser, si installa sul telefono o sul tablet come un'app e lavora anche **senza internet**. Non c'è un server: i dati restano salvati sul dispositivo e si passano da un dispositivo all'altro **a mano, tramite Google Drive** (vedi sotto).

> Nel repository non ci sono dati dell'hotel o degli ospiti. Camere, listino e conti esistono solo sui dispositivi che usano l'app.

---

## Cosa fa

- **Griglia camere**: 30 camere (1–30) e 10 postazioni extra (E1–E10) per i clienti senza camera. Le caselle con consumazioni diventano verdi (camere) o azzurre (postazioni extra) e mostrano il totale aperto.
- **Dettaglio camera**: nome ospite (facoltativo), prodotti divisi per categoria. Un tocco aggiunge il prodotto, un altro tocco aumenta la quantità. Ogni riga ha data, ora e dispositivo. Una riga sbagliata si può **annullare**: resta visibile come "annullata" e non viene addebitata.
- **Correzione rapida delle quantità**: tasto **−** sul pulsante del prodotto, **− / +** su ogni riga, oppure tocco sul numero per scrivere la quantità esatta. Portare una riga a 0 la annulla (con conferma).
- **Riepilogo check-out**: schermata pulita da mostrare al cliente, con dettaglio, totali per aliquota IVA e totale generale. "Stampa / salva PDF" (dicitura *Riepilogo non fiscale*) e "Chiudi conto", che archivia le consumazioni e libera la camera.
- **Voci di soggiorno al check-out** (solo camere): conto camera, supplemento animale domestico e tassa di soggiorno. Si indicano notti e persone, l'importo proposto si può cambiare conto per conto. Nel riepilogo compaiono in una sezione "Soggiorno" prima delle consumazioni; la tassa è indicata come *fuori campo IVA*.
- **Invio per email** del riepilogo: si apre l'app di posta del telefono con indirizzo, oggetto e testo già compilati, e si invia dal proprio account. Nessun server di posta. In alternativa **Condividi…** (WhatsApp, Gmail…), dove il telefono lo permette.
- **Storico** dei conti chiusi, filtrabile per data, con esportazione CSV.
- **Impostazioni**: listino (nome, prezzo, categoria, IVA), nomi delle camere e postazioni, nome del dispositivo, PIN facoltativo.
- **Dati**: esportazione/importazione per la sincronizzazione via Drive, CSV per Excel e avviso se l'ultima esportazione è più vecchia di 24 ore.

---

## 1. Pubblicare su GitHub Pages

Serve solo il repository su GitHub: non c'è niente da compilare né da installare.

1. Su GitHub apri il repository e vai su **Settings → Pages**.
2. In **Build and deployment → Source** scegli **Deploy from a branch**.
3. In **Branch** scegli il ramo da pubblicare (es. `main`) e la cartella **`/ (root)`**, poi **Save**.
4. Dopo uno o due minuti l'app è online all'indirizzo indicato nella stessa pagina, per esempio
   `https://nome-utente.github.io/Stella/`.

GitHub Pages usa HTTPS, che è necessario per l'installazione e per il funzionamento offline.

**Pubblicare un aggiornamento:** dopo aver modificato i file, aumenta il numero di versione in `sw.js` (riga `const VERSION = 'v1.4.3'`). Al successivo avvio, i dispositivi mostrano la barra **"È disponibile una nuova versione – Aggiorna"**. Gli aggiornamenti dell'app **non cancellano i dati**.

**Provare in locale** (facoltativo, per chi sviluppa): da questa cartella, con un qualsiasi server statico, ad esempio
`python3 -m http.server 8000` e poi apri `http://localhost:8000`.

---

## 2. Installare l'app sul telefono o sul tablet

Apri l'indirizzo dell'app **una volta con internet**, poi:

**Android (Chrome)**
1. Tocca il menu **⋮** in alto a destra.
2. Scegli **Installa app** (oppure **Aggiungi a schermata Home**).
3. L'icona del bucaneve compare tra le app.

**iPhone / iPad (Safari)** — su iPhone usare Safari, non altri browser
1. Tocca il pulsante **Condividi** (il quadrato con la freccia verso l'alto).
2. Scegli **Aggiungi alla schermata Home**, poi **Aggiungi**.

Dopo l'installazione l'app si apre a schermo intero e funziona anche senza rete.

**Al primo avvio su ogni dispositivo:** vai in **Impostazioni** e dai un nome al dispositivo (es. `BAR`, `RECEPTION`, `SALA`). Il nome compare nei file esportati e accanto a ogni consumazione.

> ⚠️ I dati stanno **nella memoria del browser** di quel dispositivo. Se si cancellano i dati di navigazione di Chrome/Safari, o si disinstalla l'app, i dati non ancora esportati si perdono. Per questo l'esportazione regolare su Drive è importante.

---

## 3. Sincronizzazione via Google Drive (procedura per il personale)

Ogni dispositivo ha i propri dati. Per vederli anche sugli altri dispositivi si passa un file attraverso una **cartella condivisa su Google Drive** (ad esempio `Bucaneve – Sincronizzazione`), creata una volta sola dal responsabile e condivisa con chi usa l'app.

### Quando farla
- **A fine turno** (o almeno una volta al giorno).
- **Prima di un check-out**, se l'ospite ha consumato anche in un altro punto (es. bar e ristorante): così il conto è completo.
- Quando l'app mostra l'avviso giallo **"Sono passate più di 24 ore"**.

### A · Inviare i propri dati (Esporta)
1. Apri l'app e tocca **Dati** (in basso).
2. Tocca **Esporta dati**. Viene scaricato un file come
   `bucaneve_BAR_2026-10-08_1030.json` (nome dispositivo, data, ora).
   - Se compare **Condividi su Drive…**, puoi usare quello e scegliere direttamente Drive e la cartella condivisa.
3. Apri l'app **Google Drive**, entra nella cartella condivisa, tocca **+ → Carica** e scegli il file appena scaricato (di solito nella cartella *Download*).

### B · Ricevere i dati degli altri (Importa)
1. In Google Drive, nella cartella condivisa, scarica il file **più recente di ogni altro dispositivo** (⋮ → *Scarica*).
2. Nell'app tocca **Dati → Scegli file da importare** e seleziona il file. Se è impostato un PIN, l'app lo chiede.
3. Compare il **riepilogo**: quante consumazioni e conti sono nuovi o aggiornati, e su quali camere.
4. Ripeti per il file di ogni altro dispositivo.

### Cose da sapere
- **Si può importare lo stesso file più volte**: non si creano doppioni. Se non c'è niente di nuovo l'app scrive *"Nessuna novità"*.
- Ogni consumazione ha un codice univoco, l'ora dell'ultima modifica e il nome del dispositivo. Se la stessa riga è stata modificata su due dispositivi (es. annullata su uno), **vince la modifica più recente**.
- L'ordine con cui si importano i file non conta.
- Dopo l'importazione conviene **esportare di nuovo**, così sul Drive c'è una copia aggiornata con i dati di tutti.
- Se un conto è stato chiuso su un dispositivo e nel frattempo un altro dispositivo ha aggiunto una consumazione alla stessa camera, dopo la sincronizzazione quella consumazione compare come **conto aperto** sulla camera: non si perde niente, va chiusa a parte.
- Le impostazioni personali del dispositivo (nome dispositivo e PIN) non vengono trasferite.
- I file su Drive possono essere eliminati periodicamente: basta tenere gli ultimi di ogni dispositivo.

### CSV per Excel
In **Dati** (o in **Storico**) scegli il periodo e tocca **Esporta CSV**. Il file contiene i conti chiusi nel periodo, una riga per consumazione: data, ora, camera, ospite, prodotto, quantità, prezzo, IVA, totale (più data di chiusura e dispositivo). Usa il punto e virgola come separatore e la virgola nei decimali, quindi si apre direttamente con Excel in italiano. Le righe annullate non sono incluse.

---

## Uso quotidiano in breve

| Cosa voglio fare | Dove |
|---|---|
| Addebitare una consumazione | **Camere** → tocca la camera → tocca il prodotto (di nuovo per aumentare la quantità) |
| Correggere una quantità (es. 4 cappuccini invece di 3) | tasto **−** sul pulsante del prodotto, oppure **− / +** sulla riga, oppure tocca il numero e scrivi la quantità giusta |
| Togliere una riga sbagliata | **Annulla** sulla riga (resta nello storico come annullata) |
| Fare il check-out | Camera → **Check-out** → aggiungi le voci di soggiorno → mostra il riepilogo → **Stampa / salva PDF** o **Invia per email** → **Chiudi conto** |
| Mandare di nuovo un riepilogo | **Storico** → tocca il conto → **Invia per email** |
| Rivedere un conto chiuso | **Storico** → scegli le date → tocca il conto |
| Cambiare prezzi o prodotti | **Impostazioni** → Listino |

Un secondo tocco sullo stesso prodotto aumenta la quantità della riga se la riga è stata aggiunta negli ultimi 15 minuti; dopo, viene creata una riga nuova con il suo orario.

**Dati struttura e logo** (Impostazioni → Dati struttura): nome, località, ragione sociale, indirizzo, partita IVA, contatti, logo e saluto finale compaiono nell'intestazione della ricevuta e nell'email. Si inseriscono su un dispositivo e arrivano agli altri con la sincronizzazione. Per la stampa conviene un logo scuro su sfondo trasparente. Nel repository non c'è nessun logo né dato reale: tutto viene inserito dall'app.

**PIN** (facoltativo, in Impostazioni): se impostato, viene chiesto per chiudere un conto, importare dati e aprire le impostazioni. È un deterrente per l'uso quotidiano, non una protezione forte: chi ha in mano il dispositivo sbloccato può comunque accedere ai dati del browser.

**Voci di soggiorno**: nel check-out di una camera, nel riquadro *Voci di soggiorno*, scrivi le **notti** e le **persone soggette a tassa**, controlla l'importo e tocca **Aggiungi** sulla voce. Il conto camera non ha un prezzo predefinito: va scritto ogni volta. Supplemento animale (10,00 € a notte) e tassa di soggiorno (1,50 € a persona a notte) hanno tariffe di esempio, da adattare in **Impostazioni → Voci di soggiorno**: valgono per tutti i dispositivi dopo la sincronizzazione. Una voce sbagliata si toglie con **Annulla**. La tassa di soggiorno si calcola su persone × notti come indicato: esenzioni (es. minori) e limiti di notti vanno considerati inserendo il numero corretto.

**Email**: **Invia per email** chiede l'indirizzo dell'ospite (viene ricordato per quel conto) e apre l'app di posta con il riepilogo nel testo del messaggio. Per allegare il PDF: prima **Stampa / salva PDF**, poi allegalo a mano. Se sul telefono non è configurata un'app di posta, il pulsante non apre nulla: usa **Condividi…**.

**IVA**: il listino di esempio usa il 10% per la somministrazione e il 22% per gli articoli vari. Sono valori **indicativi**: verificare le aliquote corrette con il commercialista (anche per conto camera e supplemento animale, preimpostati al 10%). I prezzi sono IVA inclusa; imponibile e imposta sono calcolati per scorporo sul totale di ciascuna aliquota.

Il riepilogo **non è un documento fiscale**: scontrino o fattura vanno emessi con gli strumenti abituali dell'hotel.

---

## 4. Versione con server (sincronizzazione automatica)

Con il server Stella su un VPS l'app non ha più bisogno di Drive: ogni modifica arriva sugli altri telefoni in pochi secondi. Si continua a lavorare anche senza rete; le modifiche partono appena torna.

**Chi entra e come**

| Chi | Come entra | Cosa può fare |
|---|---|---|
| Manager | email + password | tutto: listino, camere, dati struttura, dipendenti e permessi |
| Dipendente | link della struttura → sceglie il suo nome → PIN | registrare consumazioni; chiudere conti, cambiare prezzi, camere o dati struttura solo se il manager glielo permette |

Il manager crea i dipendenti in **Impostazioni → Dipendenti** (nome, PIN, permessi) e manda loro il **link di accesso** (pulsante *Copia link* o *Condividi*). Cambiare il PIN o disattivare un dipendente lo fa uscire da tutti i dispositivi. **Esci** toglie i dati dal telefono (restano sul server).

### Tre livelli: amministratore, manager, dipendenti

- **Amministratore** (chi gestisce il servizio): entra dalla scheda *Responsabile* e vede il **Pannello di gestione**: elenco strutture con lo stato dell'abbonamento (attivo, in scadenza entro 30 giorni, scaduto, disattivato), creazione di una struttura con il suo manager, logo (compare sulle ricevute), contatti, piano, importo, inizio e scadenza (*Rinnova: +1 anno*), correzione di nome ed email di accesso dei manager (pulsante *Modifica*), nuove password provvisorie, attivazione/disattivazione.
- **Manager** della struttura: riceve dall'amministratore email e **password provvisoria** (messaggio pronto da copiare); al primo accesso l'app gli chiede di sceglierne una personale. Poi gestisce listino, camere, dati della ricevuta, dipendenti e permessi.
- **Dipendenti**: link della struttura, nome e PIN.

### Installazione sul VPS (una volta sola)

1. **DNS su Cloudflare** → *DNS* → *Add record*: tipo **A**, nome **stella-app**, indirizzo IPv4 del VPS, stato proxy **Solo DNS** (nuvola grigia). Salva.
2. **Console Oracle Cloud** → *Networking* → *Virtual cloud networks* → la tua VCN → *Security Lists* → *Default Security List* → *Add Ingress Rules*: sorgente `0.0.0.0/0`, protocollo TCP, porte di destinazione **80** e poi **443**.
3. **Collegati al VPS** dal tuo computer con la chiave scaricata quando hai creato l'istanza:
   `ssh -i percorso/della/chiave ubuntu@IP-DEL-VPS` (su Oracle Linux l'utente è `opc` invece di `ubuntu`).
4. **Lancia l'installazione** e rispondi alle domande (dominio, email, nome struttura, codice struttura, manager):
   ```
   curl -fsSL https://raw.githubusercontent.com/nebry-ber/Stella/refs/heads/claude/festive-archimedes-xgdk4y/deploy/install.sh | sudo bash
   ```
   Alla fine compaiono **email e password del manager**: annotale e cambia la password al primo accesso.
5. Apri **https://stella-app.cumulonembo.com/#/gestione** (accesso per amministratore e manager) e accedi.

> Nei sottodomini usa lettere, numeri e trattini: il trattino basso `_` non è ammesso nei certificati HTTPS.

Lo script installa Docker, apre il firewall interno del VPS, avvia l'app con **Caddy** (certificato HTTPS automatico e gratuito) e programma un **backup del database ogni notte** in `/opt/stella/data/backups` (tiene gli ultimi 30).

**Aggiornare** all'ultima versione: `sudo /opt/stella/deploy/update.sh` (fa prima un backup). Se manca l'account dell'amministratore, lo script lo crea e mostra la password provvisoria.

**Comandi utili** (dal VPS, nella cartella `/opt/stella`):
- `sudo docker compose exec app node server/cli.js list`: strutture e utenti
- `sudo docker compose exec app node server/cli.js create-admin`: un altro account amministratore
- `sudo docker compose exec app node server/cli.js reset-password email@esempio.it`: nuova password a un manager
- `sudo docker compose exec app node server/cli.js add-hotel`: aggiunge un'altra struttura
- `sudo docker compose logs -f app`: messaggi del server

**Altre app sullo stesso VPS:** Caddy fa da portiere HTTPS per tutte. Per ogni app aggiungi un file `/opt/stella/sites/NOME.caddy` (istruzioni in `sites/LEGGIMI.txt`), crea il record DNS del nuovo sottodominio e riavvia Caddy con `sudo docker compose restart caddy`. Il certificato del nuovo sottodominio arriva da solo.

Nel repository non ci sono password né dati: stanno solo nel file `.env` e nella cartella `data/` del VPS.

---

## Per chi sviluppa

Solo file statici: HTML, CSS e JavaScript (moduli ES), nessuna dipendenza, nessun build.

```
index.html             struttura della pagina, intestazione con montagne, tab bar
js/sync.js             collegamento al server: accesso, sincronizzazione automatica, outbox
server/index.js        server HTTP: file dell'app + API (accessi, sincronizzazione, dipendenti)
server/sync.js         unione dei dati sul server e controllo dei permessi
server/auth.js         password/PIN (scrypt), sessioni, blocco dei tentativi
server/db.js           database SQLite (node:sqlite, incluso in Node 22)
server/cli.js          comandi di amministrazione (init, add-hotel, reset-password, backup)
deploy/                install.sh, update.sh, Caddyfile; Dockerfile e docker-compose.yml nella radice
css/app.css            stile (palette cielo / prati / neve / roccia), stampa
js/app.js              interfaccia: schermate, eventi, navigazione (#/…)
js/store.js            servizio dati: tutte le operazioni (aggiungi, chiudi conto, importa…)
js/model.js            regole pure: totali, IVA, unione dati, CSV, date (testabili)
js/db.js               adattatore IndexedDB (unico file che usa IndexedDB)
sw.js                  service worker: cache dei file per l'uso offline
manifest.webmanifest   dati per l'installazione come app
icons/                 icone
tests/model.test.mjs   test della logica (node --test)
```

**Separazione dei livelli:** l'interfaccia chiama solo `store.js`; `store.js` usa `db.js` per salvare e `model.js` per i calcoli. Per passare a un backend si scrive un adattatore con le stesse funzioni di `db.js` (`open`, `getAll`, `get`, `put`, `putMany`, `clear`) che chiama un'API, oppure si riscrivono le funzioni di `store.js` mantenendone le firme: l'interfaccia non cambia.

**Modello dei dati** (importi sempre in centesimi; ogni record ha `id`, `updatedAt`, `device`):

| Archivio | Contenuto |
|---|---|
| `locations` | camere e postazioni: `kind` (`camera`/`extra`), `label`, `guestName`, `active` |
| `products` | listino: `name`, `price`, `category`, `vat`, `active` (i prodotti eliminati restano disattivati, così la sincronizzazione funziona). Le tariffe di soggiorno sono prodotti con categoria `soggiorno` e id fissi `stay-room`, `stay-pet`, `stay-tax` |
| `consumptions` | righe addebitate: copia di nome/prezzo/IVA, `qty`, `createdAt`, `cancelled`, `accountId` (`null` finché il conto è aperto) |
| `config` | dati della struttura (record `hotel`: nome, indirizzo, P.IVA, logo come immagine incorporata) |
| `accounts` | conti chiusi: `locationName`, `guestName`, `guestEmail`, `closedAt`, `total` |
| `meta` | impostazioni locali del dispositivo (non esportate) |

Camere, postazioni e prodotti iniziali hanno id fissi (`R1`…`R30`, `E1`…`E10`, `p001`…), così dispositivi inizializzati separatamente non creano doppioni alla prima sincronizzazione.

**Modalità:** l'app capisce da sola dove gira. Servita dal server Stella usa la sincronizzazione automatica (`/api/sync`: invia l'outbox, riceve le novità dopo un cursore, vince la modifica più recente, i permessi sono controllati dal server). Servita da un sito statico (es. GitHub Pages) funziona senza server con esportazione/importazione via file.

**Server in locale:** `node server/cli.js init` (domande guidate), poi `npm start` e apri `http://localhost:3000`.

**Test:** `npm test` dalla cartella del progetto (Node 22.13 o successivo): logica, server, permessi e sincronizzazione.
