#!/usr/bin/env bash
# Aggiorna il server Stella all'ultima versione e lo riavvia (i dati restano).
#   sudo /opt/stella/deploy/update.sh
#
# Funziona in due tempi: scarica la nuova versione, poi riparte con lo script
# appena scaricato (così le novità dell'aggiornamento valgono subito).
# Tutto è dentro main(): bash legge l'intero file prima di eseguirlo, quindi
# sostituire questo file durante l'esecuzione non crea problemi.
set -euo pipefail

main() {
  cd "$(dirname "$0")/.."
  local cli=(docker compose exec -T app node --disable-warning=ExperimentalWarning server/cli.js)

  if [ "${1:-}" != "--dopo-download" ]; then
    local branch
    branch="$(git rev-parse --abbrev-ref HEAD)"
    echo "▶ Backup prima dell'aggiornamento"
    "${cli[@]}" backup || true
    echo "▶ Scarico l'ultima versione ($branch)"
    git fetch --quiet origin "$branch"
    git reset --quiet --hard "origin/$branch"
    exec bash "$PWD/deploy/update.sh" --dopo-download
  fi

  echo "▶ Riavvio"
  docker compose up -d --build
  docker image prune -f >/dev/null
  for _ in $(seq 1 30); do
    docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
    sleep 2
  done

  # Pannello di gestione: se non esiste ancora un amministratore, lo crea ora
  if ! "${cli[@]}" has-admin; then
    echo
    echo "▶ Creo il tuo account di amministratore (pannello di gestione)"
    echo "  Ti chiedo nome ed email; la password provvisoria compare alla fine."
    docker compose exec app node --disable-warning=ExperimentalWarning server/cli.js create-admin </dev/tty
  fi
  echo "✓ Aggiornato. Accesso responsabili: https://$(grep '^DOMAIN=' .env | cut -d= -f2)/#/gestione"
}

main "$@"
exit
