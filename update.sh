#!/usr/bin/env bash
# Met à jour Cowork Queue : récupère la dernière version et redémarre les conteneurs.
set -euo pipefail

cd "$(dirname "$0")"

# Si le dossier est un clone git, on récupère aussi les fichiers (compose, scripts).
if [ -d .git ]; then
  echo "→ Mise à jour du dépôt (git pull --ff-only)"
  git pull --ff-only
fi

echo "→ Téléchargement des images"
docker compose pull
echo "→ Redémarrage des conteneurs"
docker compose up -d

# PUBLIC_URL est lue dans .env (sans exécuter le fichier).
public_url=""
if [ -f .env ]; then
  public_url="$(grep -E '^PUBLIC_URL=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r"'"'" || true)"
fi

if [ -z "$public_url" ]; then
  echo "PUBLIC_URL introuvable dans .env : vérification de santé ignorée."
  exit 0
fi

echo "→ Vérification de santé (${public_url%/}/healthz)"
for _ in $(seq 1 30); do
  if body="$(curl -fsS --max-time 5 "${public_url%/}/healthz" 2>/dev/null)"; then
    echo "OK : $body"
    exit 0
  fi
  sleep 2
done

echo "Le service ne répond pas encore sur ${public_url%/}/healthz ; consultez : docker compose logs --tail=50" >&2
exit 1
