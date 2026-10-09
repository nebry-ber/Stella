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
echo "✓ Aggiornato"
