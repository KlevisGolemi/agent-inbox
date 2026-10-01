#!/usr/bin/env bash
# Désinstalle Cowork Queue : propose une sauvegarde des données, puis supprime conteneurs,
# volumes, image et .env.
#
# Usage : ./uninstall.sh [--yes] [--no-backup] [--help]
#   --yes         ne pose aucune question (la sauvegarde est faite sauf avec --no-backup)
#   --no-backup   ne propose ni ne crée de sauvegarde
set -euo pipefail

if [ -t 1 ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi
info() { printf '%s\n' "${BLUE}→${NC} $*"; }
ok() { printf '%s\n' "${GREEN}✓${NC} $*"; }
warn() { printf '%s\n' "${YELLOW}!${NC} $*" >&2; }
fail() { printf '%s\n' "${RED}✗${NC} $*" >&2; exit 1; }

AUTO_YES=false
NO_BACKUP=false
for arg in "$@"; do
  case "$arg" in
    --yes) AUTO_YES=true ;;
    --no-backup) NO_BACKUP=true ;;
    -h | --help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Option inconnue : $arg (voir --help)" ;;
  esac
done

cd "$(dirname "$0")"

# confirm <question> <défaut y|n> : succès si oui ; --yes répond toujours oui.
confirm() {
  local question="$1" default="${2:-n}" reply
  $AUTO_YES && return 0
  read -r -p "  $question [$([ "$default" = "y" ] && echo 'O/n' || echo 'o/N')] " reply || reply=""
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[YyOo] ]]
}

# env_get <clé> : dernière valeur dans .env, sans l'exécuter (guillemets et commentaire retirés).
env_get() {
  [ -f .env ] || return 0
  grep -E "^[[:space:]]*$1[[:space:]]*=" .env | tail -n 1 \
    | sed -E 's/^[^=]*=//; s/\r$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' || true
}

command -v docker >/dev/null 2>&1 || fail "Docker est requis."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 est requis."
docker info >/dev/null 2>&1 || fail "Le démon Docker ne répond pas."

VOLUME="$(env_get QUEUE_VOLUME_NAME)"
VOLUME="${VOLUME:-cowork-queue-data}"

echo
info "Désinstallation de Cowork Queue"
warn "Opération destructive : la base (messages, comptes, clés API, réglages) sera supprimée."
confirm "Continuer ?" n || { info "Annulé."; exit 0; }

# ─── 1. Sauvegarde du volume de données ───────────────────────
if ! $NO_BACKUP && docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  if confirm "Sauvegarder d'abord le volume « $VOLUME » dans le dossier courant ?" y; then
    ARCHIVE="cowork-queue-backup-$(date +%Y%m%d-%H%M%S).tgz"
    info "Création de $ARCHIVE"
    docker run --rm -v "$VOLUME":/data:ro -v "$PWD":/b alpine tar czf "/b/$ARCHIVE" -C /data . \
      || fail "La sauvegarde a échoué : rien n'a été supprimé."
    chmod 600 "$ARCHIVE" 2>/dev/null || true
    ok "Sauvegarde créée : $PWD/$ARCHIVE"
  fi
fi

# ─── 2. Conteneurs et volumes ─────────────────────────────────
info "Arrêt et suppression des conteneurs et des volumes"
docker compose --profile '*' down --volumes --remove-orphans
# Un volume de la v1 réutilisé peut ne pas dépendre du projet courant : suppression explicite.
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  docker volume rm "$VOLUME" >/dev/null && ok "Volume « $VOLUME » supprimé"
fi

# ─── 3. Images ────────────────────────────────────────────────
IMAGES="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^ghcr\.io/klevisgolemi/cowork-queue:' || true)"
if [ -n "$IMAGES" ] && confirm "Supprimer l'image Docker de Cowork Queue ?" y; then
  # shellcheck disable=SC2086 # une image par ligne, sans espace dans les noms
  docker rmi $IMAGES >/dev/null 2>&1 && ok "Image supprimée" || warn "Image non supprimée (encore utilisée ?)"
fi

# ─── 4. Fichier .env ──────────────────────────────────────────
if [ -f .env ]; then
  if confirm "Supprimer le fichier .env (secrets de l'installation) ?" y; then
    rm -f .env
    ok ".env supprimé"
  else
    warn ".env conservé : retirez-le vous-même si vous ne réinstallez pas."
  fi
fi

echo
ok "Désinstallation terminée."
info "Pour réinstaller : ./install.sh"
