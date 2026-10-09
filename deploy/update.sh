#!/usr/bin/env bash
# Aggiorna il server Stella all'ultima versione e lo riavvia (i dati restano).
#   sudo /opt/stella/deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "▶ Backup prima dell'aggiornamento"
docker compose exec -T app node --disable-warning=ExperimentalWarning server/cli.js backup || true
echo "▶ Scarico l'ultima versione ($BRANCH)"
git fetch --quiet origin "$BRANCH"
git reset --quiet --hard "origin/$BRANCH"
echo "▶ Riavvio"
docker compose up -d --build
docker image prune -f >/dev/null
for _ in $(seq 1 30); do
  docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
  sleep 2
done
# Pannello di gestione: se non esiste ancora un amministratore, lo crea ora
if ! docker compose exec -T app node --disable-warning=ExperimentalWarning server/cli.js has-admin; then
  echo "▶ Creo il tuo account di amministratore (pannello di gestione)"
  docker compose exec app node --disable-warning=ExperimentalWarning server/cli.js create-admin </dev/tty
fi
echo "✓ Aggiornato"
