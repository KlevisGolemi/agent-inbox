#!/usr/bin/env bash
# Met à jour Agent Inbox : récupère la dernière version et redémarre les conteneurs.
set -euo pipefail

cd "$(dirname "$0")"

# Si le dossier est un clone git, on récupère aussi les fichiers (compose, scripts).
if [ -d .git ]; then
  printf "%s\n" "→ Mise à jour du dépôt (git pull --ff-only)"
  git pull --ff-only
fi

printf "%s\n" "→ Téléchargement des images"
docker compose pull
printf "%s\n" "→ Redémarrage des conteneurs"
docker compose up -d

# PUBLIC_URL est lue dans .env (sans exécuter le fichier) : dernière occurrence,
# sans commentaire en fin de ligne, sans guillemets ni espaces autour.
public_url=""
if [ -f .env ]; then
  public_url="$(grep -E '^[[:space:]]*PUBLIC_URL[[:space:]]*=' .env | tail -n 1 \
    | sed -E 's/^[^=]*=//; s/[[:space:]]+#.*$//; s/\r$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' || true)"
fi

if [ -z "$public_url" ]; then
  printf '%s\n' "Avertissement : PUBLIC_URL introuvable ou vide dans .env ; essai sur http://localhost:3000." >&2
  public_url="http://localhost:3000"
fi

health_url="${public_url%/}/healthz"
printf '%s\n' "→ Vérification de santé (${health_url})"
for _ in $(seq 1 30); do
  if body="$(curl -fsS --max-time 5 "$health_url" 2>/dev/null)"; then
    printf '%s\n' "OK : $body"
    exit 0
  fi
  sleep 2
done

printf '%s\n' "Le service ne répond pas encore sur ${health_url} ; consultez : docker compose logs --tail=50" >&2
exit 1
