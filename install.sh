#!/usr/bin/env bash
# Installe Agent Inbox : génère .env, démarre les conteneurs et attend que le service réponde.
#
# Usage : ./install.sh [--force] [--help]
# Non interactif : CQ_YES=1 CQ_PUBLIC_URL=https://queue.example.com ./install.sh
#   CQ_PUBLIC_URL       domaine ou URL publique (ou IPv4 : converti en <ip-avec-tirets>.sslip.io)
#   CQ_MODE             caddy (défaut) | traefik
#   CQ_TRAEFIK_HOSTS    domaines Traefik séparés par des virgules (défaut : l'hôte de CQ_PUBLIC_URL)
#   CQ_TRAEFIK_NETWORK  réseau Docker partagé avec Traefik (défaut : aucun, ex. Traefik en mode host)
#   CQ_BEHIND_CLOUDFLARE  1 = derrière Cloudflare (proxy orange) : TRUST_PROXY=2 (défaut : 0 → 1)
#   CQ_TRAEFIK_CERTRESOLVER  certresolver Traefik (défaut : letsencrypt)
#   CQ_ADMIN_EMAIL, CQ_ADMIN_PASSWORD   compte administrateur (facultatif, 12 caractères min.)
#   CQ_UPDATER          yes | no (défaut : no) — mise à jour en un clic depuis l'interface
#   CQ_YES=1            n'interroge jamais : valeurs par défaut pour tout ce qui n'est pas fourni
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

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    -h | --help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Option inconnue : $arg (voir --help)" ;;
  esac
done

cd "$(dirname "$0")"

NON_INTERACTIVE=false
[ "${CQ_YES:-0}" = "1" ] && NON_INTERACTIVE=true
[ -t 0 ] || NON_INTERACTIVE=true

# ask <variable> <question> [défaut] : lit une valeur, ou garde le défaut en mode non interactif.
ask() {
  local var="$1" question="$2" default="${3:-}" reply
  if $NON_INTERACTIVE; then
    printf -v "$var" '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then
    read -r -p "  $question [$default] " reply || reply=""
  else
    read -r -p "  $question " reply || reply=""
  fi
  printf -v "$var" '%s' "${reply:-$default}"
}

# confirm <question> <défaut y|n> : succès si oui.
confirm() {
  local question="$1" default="${2:-n}" reply
  if $NON_INTERACTIVE; then
    [ "$default" = "y" ]
    return
  fi
  read -r -p "  $question [$([ "$default" = "y" ] && echo 'O/n' || echo 'o/N')] " reply || reply=""
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[YyOo] ]]
}

# ─── 1. Prérequis ─────────────────────────────────────────────
for cmd in docker openssl curl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "« $cmd » est requis mais introuvable."
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 est requis (commande « docker compose »)."
docker info >/dev/null 2>&1 || fail "Le démon Docker ne répond pas (est-il démarré ? droits suffisants ?)."

if [ -f .env ] && ! $FORCE; then
  fail "Un fichier .env existe déjà : installation annulée pour ne rien écraser. Relancez avec --force pour le régénérer (sauvegardez-le d'abord)."
fi

echo
info "Installation de Agent Inbox"

# ─── 2. Domaine ou IP ─────────────────────────────────────────
INPUT="${CQ_PUBLIC_URL:-}"
if [ -z "$INPUT" ]; then
  $NON_INTERACTIVE && fail "CQ_PUBLIC_URL est obligatoire en mode non interactif."
  ask INPUT "Domaine (ex. queue.example.com) ou IP publique du serveur :"
fi
[ -n "$INPUT" ] || fail "Aucun domaine ni IP fournis."

HOST="${INPUT#*://}"   # sans schéma
HOST="${HOST%%/*}"     # sans chemin
HOST="${HOST%%:*}"     # sans port
HOST="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]')"
[[ "$HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "Nom d'hôte invalide : « $HOST »."

is_ipv4() {
  local ip="$1" octet
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  local IFS=.
  for octet in $ip; do
    [ "$((10#$octet))" -le 255 ] || return 1
  done
}

if is_ipv4 "$HOST"; then
  SSLIP_HOST="${HOST//./-}.sslip.io"
  info "Let's Encrypt ne délivre pas de certificat pour une IP : sslip.io fournit $SSLIP_HOST (résolu vers $HOST)."
  if confirm "Utiliser $SSLIP_HOST ?" y; then
    HOST="$SSLIP_HOST"
  else
    fail "Un nom de domaine est nécessaire pour obtenir un certificat HTTPS."
  fi
fi
PUBLIC_URL="https://$HOST"

# Vérification DNS (avertissement seulement : l'enregistrement peut être en cours de propagation).
resolve_host() {
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$1" | awk '{print $1; exit}'
  elif command -v dscacheutil >/dev/null 2>&1; then
    dscacheutil -q host -a name "$1" | awk '/^ip_address:/ {print $2; exit}'
  elif command -v host >/dev/null 2>&1; then
    host "$1" | awk '/has address/ {print $4; exit}'
  fi
}
RESOLVED="$(resolve_host "$HOST" 2>/dev/null || true)"
if [ -z "$RESOLVED" ]; then
  warn "$HOST ne se résout pas encore : créez l'enregistrement DNS vers ce serveur avant la première visite (sinon pas de certificat)."
else
  ok "$HOST → $RESOLVED"
fi

# ─── 3. Mode de reverse proxy ─────────────────────────────────
MODE="${CQ_MODE:-}"
if [ -z "$MODE" ]; then
  if confirm "Utiliser un Traefik déjà installé au lieu de Caddy (inclus) ?" n; then MODE=traefik; else MODE=caddy; fi
fi
case "$MODE" in caddy | traefik) ;; *) fail "CQ_MODE doit valoir « caddy » ou « traefik » (reçu : $MODE)." ;; esac

TRAEFIK_NETWORK="${CQ_TRAEFIK_NETWORK:-}"
TRUST_PROXY=1
TRAEFIK_CERTRESOLVER="${CQ_TRAEFIK_CERTRESOLVER:-letsencrypt}"
TRAEFIK_RULE=""
if [ "$MODE" = "traefik" ]; then
  HOSTS_INPUT="${CQ_TRAEFIK_HOSTS:-}"
  [ -n "$HOSTS_INPUT" ] || ask HOSTS_INPUT "Domaines servis par Traefik (séparés par des virgules) :" "$HOST"
  IFS=',' read -r -a HOST_LIST <<<"$HOSTS_INPUT"
  for h in "${HOST_LIST[@]}"; do
    h="$(printf '%s' "$h" | tr -d '[:space:]')"
    [ -n "$h" ] || continue
    [[ "$h" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "Domaine Traefik invalide : « $h »."
    TRAEFIK_RULE="${TRAEFIK_RULE:+$TRAEFIK_RULE || }Host(\`$h\`)"
  done
  [ -n "$TRAEFIK_RULE" ] || fail "Aucun domaine Traefik valide."
  if [ -z "$TRAEFIK_NETWORK" ] && [ -z "${CQ_TRAEFIK_NETWORK+x}" ]; then
    ask TRAEFIK_NETWORK "Réseau Docker partagé avec Traefik (vide = aucun, ex. Traefik en mode host) :"
  fi
  # Valeurs écrites telles quelles dans .env (et reprises dans les labels) : caractères sûrs uniquement.
  [[ "$TRAEFIK_CERTRESOLVER" =~ ^[A-Za-z0-9_.-]+$ ]] \
    || fail "CQ_TRAEFIK_CERTRESOLVER invalide : « $TRAEFIK_CERTRESOLVER » (lettres, chiffres, . _ - uniquement)."
  if [ -n "$TRAEFIK_NETWORK" ]; then
    [[ "$TRAEFIK_NETWORK" =~ ^[A-Za-z0-9_.-]+$ ]] \
      || fail "CQ_TRAEFIK_NETWORK invalide : « $TRAEFIK_NETWORK » (lettres, chiffres, . _ - uniquement)."
    docker network inspect "$TRAEFIK_NETWORK" >/dev/null 2>&1 \
      || fail "Le réseau Docker « $TRAEFIK_NETWORK » n'existe pas (créez-le ou laissez CQ_TRAEFIK_NETWORK vide)."
  fi
  # Cloudflare + Traefik = 2 proxys devant l'application : sans TRUST_PROXY=2, req.ip serait celle de Cloudflare.
  BEHIND_CF="${CQ_BEHIND_CLOUDFLARE:-}"
  if [ -z "$BEHIND_CF" ]; then
    if confirm "Derrière Cloudflare (proxy orange) ?" n; then BEHIND_CF=1; else BEHIND_CF=0; fi
  fi
  [ "$BEHIND_CF" = "1" ] && TRUST_PROXY=2
fi

# ─── 4. Compte administrateur (facultatif) ────────────────────
ADMIN_EMAIL="${CQ_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${CQ_ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_EMAIL" ] && [ -z "$ADMIN_PASSWORD" ] && ! $NON_INTERACTIVE; then
  echo "  Compte administrateur : laissez vide pour le créer plus tard avec un code de setup."
  ask ADMIN_EMAIL "E-mail administrateur :"
  if [ -n "$ADMIN_EMAIL" ]; then
    read -r -s -p "  Mot de passe (12 caractères min.) : " ADMIN_PASSWORD || ADMIN_PASSWORD=""
    echo
  fi
fi
if [ -n "$ADMIN_EMAIL$ADMIN_PASSWORD" ]; then
  [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ] || fail "E-mail et mot de passe administrateur vont ensemble."
  [[ "$ADMIN_EMAIL" =~ ^[^[:space:]@\'\"]+@[^[:space:]@\'\"]+$ ]] || fail "E-mail administrateur invalide."
  [ "${#ADMIN_PASSWORD}" -ge 12 ] || fail "Le mot de passe administrateur doit contenir au moins 12 caractères."
  case "$ADMIN_PASSWORD" in
    *$'\n'* | *$'\r'*) fail "Le mot de passe ne peut pas contenir de saut de ligne." ;;
  esac
fi

# ─── 5. Mise à jour en un clic (facultatif) ───────────────────
UPDATER="${CQ_UPDATER:-}"
if [ -z "$UPDATER" ]; then
  if confirm "Activer la mise à jour en un clic depuis l'interface (monte le socket Docker) ?" n; then UPDATER=yes; else UPDATER=no; fi
fi
case "$UPDATER" in yes | no) ;; *) fail "CQ_UPDATER doit valoir « yes » ou « no »." ;; esac

# ─── 6. Écriture de .env ──────────────────────────────────────
info "Écriture de .env"
umask 077
{
  echo "# Généré par install.sh le $(date -u +%Y-%m-%dT%H:%M:%SZ). Voir .env.example pour toutes les options."
  echo "PUBLIC_URL=$PUBLIC_URL"
  echo "SITE_HOST=$HOST"
  echo "COMPOSE_PROJECT_NAME=agent-inbox"
  if [ "$MODE" = "traefik" ]; then
    if [ -n "$TRAEFIK_NETWORK" ]; then
      echo "COMPOSE_FILE=deploy/docker-compose.traefik.yml:deploy/docker-compose.traefik-network.yml"
      echo "TRAEFIK_NETWORK=$TRAEFIK_NETWORK"
    else
      echo "COMPOSE_FILE=deploy/docker-compose.traefik.yml"
    fi
    echo "TRUST_PROXY=$TRUST_PROXY"
    echo "TRAEFIK_CERTRESOLVER=$TRAEFIK_CERTRESOLVER"
    echo "TRAEFIK_RULE='$TRAEFIK_RULE'"
  fi
  if [ "$UPDATER" = "yes" ]; then
    echo "COMPOSE_PROFILES=updater"
    echo "UPDATER_URL=http://updater:8081"
    echo "UPDATER_SECRET=$(openssl rand -hex 32)"
  fi
} >.env
chmod 600 .env
ok ".env créé (droits 600)"

# ─── 7. Démarrage ─────────────────────────────────────────────
info "Démarrage des conteneurs (le premier lancement télécharge l'image)"
docker compose up -d

info "Attente du service (120 s max)"
healthy=false
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
if ! $healthy; then
  docker compose logs --tail=40 app >&2 || true
  fail "Le service ne répond pas sur /healthz après 120 s. Consultez : docker compose logs app"
fi
ok "Le service répond"

# Joignabilité publique : informatif (le certificat peut demander quelques instants).
public_ok=false
for _ in $(seq 1 15); do
  if curl -fsS --max-time 5 -o /dev/null "$PUBLIC_URL/healthz" 2>/dev/null; then public_ok=true; break; fi
  sleep 2
done
if $public_ok; then
  ok "$PUBLIC_URL/healthz est joignable"
else
  warn "$PUBLIC_URL n'est pas encore joignable (DNS, ports 80/443 ou émission du certificat en cours). Réessayez dans une minute."
fi

# ─── 8. Compte administrateur ─────────────────────────────────
# Le mot de passe ne touche jamais .env : il passe par stdin vers la commande create-admin.
ADMIN_CREATED=false
if [ -n "$ADMIN_EMAIL" ]; then
  if printf '%s\n' "$ADMIN_PASSWORD" | docker compose exec -T app node dist/cli.js create-admin "$ADMIN_EMAIL"; then
    ADMIN_CREATED=true
  else
    warn "Création du compte impossible : utilisez le code de setup ci-dessous."
  fi
fi

# ─── 9. Résumé ────────────────────────────────────────────────
echo
ok "Agent Inbox est installé."
echo "  Interface d'administration : $PUBLIC_URL/admin"
echo "  Adresse MCP (Claude, ChatGPT) : $PUBLIC_URL/mcp"
echo "  Données (volume /data) : base, sauvegardes et pièces jointes dans /data/files (non sauvegardées)"
if ! $ADMIN_CREATED; then
  echo
  echo "  Aucun compte administrateur : ouvrez $PUBLIC_URL/setup et saisissez le code de setup :"
  echo "    docker compose logs app | grep -i setup"
fi
echo
echo "  Mise à jour : ./update.sh   ·   Désinstallation : ./uninstall.sh"
