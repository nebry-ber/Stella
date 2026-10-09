#!/usr/bin/env bash
# =============================================================================
#  Installazione del server Stella su un VPS (Ubuntu o Oracle Linux).
#
#  Dal terminale del VPS:
#    curl -fsSL https://raw.githubusercontent.com/nebry-ber/Stella/refs/heads/claude/festive-archimedes-xgdk4y/deploy/install.sh | sudo bash
#
#  Cosa fa:
#   1. installa Docker (se manca) e git
#   2. apre le porte 80 e 443 nel firewall del sistema
#   3. scarica l'app in /opt/stella
#   4. chiede il dominio e l'email per il certificato HTTPS
#   5. avvia app + Caddy (HTTPS automatico)
#   6. crea la prima struttura e il manager (domande guidate)
#   7. programma un backup del database ogni notte alle 3:30
#  Si può rilanciare senza problemi: i passaggi già fatti vengono saltati.
# =============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/nebry-ber/Stella.git}"
BRANCH="${BRANCH:-claude/festive-archimedes-xgdk4y}"
DIR="${DIR:-/opt/stella}"

say()  { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
ask()  { local q="$1" def="${2:-}" a; read -r -p "$q${def:+ [$def]}: " a </dev/tty; printf '%s' "${a:-$def}"; }

[ "$(id -u)" -eq 0 ] || { echo "Esegui lo script con sudo."; exit 1; }
. /etc/os-release

# --- 1. Docker e git ----------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installo Docker"
  case "$ID" in
    ubuntu|debian) curl -fsSL https://get.docker.com | sh ;;
    ol|rhel|centos|rocky|almalinux)
      dnf -y install dnf-plugins-core
      dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin ;;
    *) echo "Sistema operativo non riconosciuto ($ID)."; exit 1 ;;
  esac
  systemctl enable --now docker
fi
if ! command -v git >/dev/null 2>&1; then
  say "Installo git"
  if command -v apt-get >/dev/null; then apt-get update -y && apt-get install -y git; else dnf -y install git; fi
fi

# --- 2. Firewall del sistema (le immagini Oracle bloccano tutto tranne SSH) ----
say "Apro le porte 80 e 443"
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http --add-service=https
  firewall-cmd --reload
elif command -v iptables >/dev/null 2>&1; then
  pos=$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')
  for p in 443 80; do
    if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null; then
      if [ -n "$pos" ]; then iptables -I INPUT "$pos" -p tcp -m state --state NEW --dport "$p" -j ACCEPT
      else iptables -A INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT; fi
    fi
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save
  elif [ -d /etc/iptables ]; then iptables-save > /etc/iptables/rules.v4; fi
fi
warn "Ricorda: le porte 80 e 443 vanno aperte anche nella console Oracle (Security List della VCN)."

# --- 3. Codice dell'app --------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Aggiorno l'app in $DIR"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH"
  git -C "$DIR" reset --quiet --hard "origin/$BRANCH"
else
  say "Scarico l'app in $DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR"

# --- 4. Impostazioni -------------------------------------------------------------
if [ ! -f .env ]; then
  say "Impostazioni"
  DOMAIN=$(ask "Dominio dell'app (lettere, numeri e trattini: niente _ )" "stella-app.cumulonembo.com")
  case "$DOMAIN" in *_*) echo "Il dominio non può contenere \"_\" (non è ammesso nei certificati HTTPS)."; exit 1 ;; esac
  ACME_EMAIL=$(ask "Email per il certificato HTTPS (avvisi di scadenza)")
  printf 'DOMAIN=%s\nACME_EMAIL=%s\n' "$DOMAIN" "$ACME_EMAIL" > .env
  chmod 600 .env
fi
. ./.env
MYIP=$(curl -fsS https://api.ipify.org || true)
DNSIP=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)
if [ -n "$MYIP" ] && [ "$MYIP" != "$DNSIP" ]; then
  warn "$DOMAIN punta a '${DNSIP:-nessun indirizzo}', ma questo server è $MYIP."
  warn "Crea su Cloudflare il record A '${DOMAIN%%.*}' → $MYIP (nuvola GRIGIA, 'Solo DNS'), poi rilancia lo script."
  warn "Senza DNS corretto il certificato HTTPS non può essere emesso."
fi

# --- 5. Avvio --------------------------------------------------------------------
mkdir -p data sites
[ -f sites/LEGGIMI.txt ] || cat > sites/LEGGIMI.txt <<'TXT'
Altre app sullo stesso VPS
--------------------------
Caddy (il "portiere" HTTPS di questo VPS) serve anche le altre tue app.
Per ognuna crea qui un file NOME.caddy, ad esempio meteo.caddy:

    meteo.cumulonembo.com {
        reverse_proxy host.docker.internal:8081
    }

dove 8081 è la porta su cui gira l'altra app sul VPS. Poi:
    cd /opt/stella && sudo docker compose restart caddy
Ricorda il record DNS su Cloudflare (A, nuvola grigia) per il nuovo sottodominio.
TXT
chown -R 1000:1000 data
say "Avvio app e Caddy (la prima volta richiede qualche minuto)"
docker compose up -d --build
for _ in $(seq 1 30); do
  docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
  sleep 2
done

# --- 6. Prima struttura e manager -------------------------------------------------
say "Configurazione della struttura"
docker compose exec app node --disable-warning=ExperimentalWarning server/cli.js init </dev/tty

# --- 6b. Account dell'amministratore (pannello di gestione) ----------------------
if ! docker compose exec -T app node --disable-warning=ExperimentalWarning server/cli.js has-admin; then
  say "Il tuo account di amministratore"
  docker compose exec app node --disable-warning=ExperimentalWarning server/cli.js create-admin </dev/tty
fi

# --- 7. Backup notturno -----------------------------------------------------------
cat > /etc/cron.d/stella-backup <<CRON
# Backup del database Stella ogni notte (tiene gli ultimi 30, in $DIR/data/backups)
30 3 * * * root cd $DIR && docker compose exec -T app node --disable-warning=ExperimentalWarning server/cli.js backup >> /var/log/stella-backup.log 2>&1
CRON

say "Fatto!"
echo "  App:          https://$DOMAIN"
echo "  Aggiornare:   sudo $DIR/deploy/update.sh"
echo "  Comandi:      cd $DIR && sudo docker compose exec app node server/cli.js   (list, add-hotel, reset-password, backup)"
