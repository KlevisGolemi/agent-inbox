# Sécurité

## Signaler une vulnérabilité

Ne créez pas d'issue publique. Utilisez le signalement privé de GitHub :
**Security → Report a vulnerability** sur
[KlevisGolemi/cowork-communication](https://github.com/KlevisGolemi/cowork-communication/security/advisories/new).

Indiquez la version, les étapes de reproduction et l'impact. Le projet est maintenu par une seule personne :
comptez quelques jours pour un premier retour.

## Périmètre

Dans le périmètre : le code de ce dépôt (application, scripts `install.sh` / `update.sh` / `uninstall.sh`,
fichiers `deploy/`, sidecar `updater`) et sa configuration par défaut.

Hors périmètre : Docker, Caddy, Traefik, les clients MCP (Claude, ChatGPT), n8n, et une configuration
qui s'écarte de la documentation (par exemple l'application publiée directement, sans proxy).

Seule la dernière version publiée reçoit des correctifs.

## Surfaces sensibles

| Surface | Protection |
|---|---|
| `POST /webhook`, `/next`, `/peek`… | Secret partagé `x-webhook-secret` (comparaison en temps constant), relu à chaque requête : une rotation est immédiate. Limite de débit sur `/webhook` et `/next`. |
| `/mcp` | Jeton OAuth 2.1 (PKCE S256, expiration 1 h, refresh 30 jours) ou clé API `cwk_…`. Seul le condensé SHA-256 est stocké. Limite de 600 requêtes par minute et par IP. |
| Attentes longues (`GET /next?wait`, `queue_wait`) | 100 attentes simultanées au plus (au-delà : `429 too_many_waiters` / erreur MCP) ; `GET /next` limité à 600 requêtes par minute et par IP. |
| `/admin`, `/admin/api` | Session par cookie (7 jours), jeton CSRF sur toutes les écritures, mot de passe haché avec `scrypt` (12 caractères minimum). Page servie avec une CSP restrictive ; scripts CDN à version épinglée et contrôle d'intégrité (SRI). |
| Changement de mot de passe | Depuis l'interface ou avec `reset-password` : les autres sessions sont fermées et tous les jetons OAuth du compte sont révoqués (les connecteurs doivent se reconnecter). Les clés API `cwk_…` restent valides : révoquez-les dans Admin → Connexions si elles ont pu fuiter. |
| `/login`, `/setup`, `/token`, `/register` | Limite de 10 requêtes par minute et par IP. |
| Logs | Une ligne JSON par événement, sans secret, jeton ni payload. Seule exception : le code de setup, affiché tant qu'aucun compte n'existe. |

## Compromis assumés

- **Sidecar `updater`** (opt-in) : il monte le socket Docker, donc il équivaut à un accès root sur
  l'hôte. Il n'écoute que sur le réseau Compose, protégé par un secret de 32 caractères minimum.
  N'activez-le que si vous acceptez ce risque ; sinon utilisez `./update.sh`.
- **Réseau Traefik partagé** : en attachant l'application à un réseau Traefik partagé, tout conteneur
  de ce réseau peut la joindre directement et peut forger `X-Forwarded-For`. N'y mettez que des services de confiance.
- **Application jamais publiée** : le limiteur de débit ne fait confiance qu'à `TRUST_PROXY` proxys.
  Exposer le port 3000 permettrait de contourner la limite en falsifiant l'en-tête.
- **`client_secret` OAuth** : pour les clients confidentiels enregistrés dynamiquement, le secret est
  conservé en clair dans la base, comme l'exige le SDK MCP (il doit pouvoir le comparer). Il n'expire pas,
  car un connecteur ne peut pas se réenregistrer seul ; un client enregistré depuis plus de 30 jours et
  sans aucun jeton actif est toutefois supprimé par le nettoyage (il faut alors réajouter le connecteur).
  Le jeton d'accès et le refresh token, eux, sont hachés.
  Protégez le volume et les sauvegardes en conséquence.
- **Instance unique** : les demandes de consentement en cours et le code de setup vivent en mémoire du
  processus. Faire tourner plusieurs réplicas derrière un répartiteur n'est pas pris en charge.
- **Secret du webhook** : l'interface l'affiche à un administrateur connecté. Quiconque le détient peut
  écrire et lire la file via l'API HTTP.
