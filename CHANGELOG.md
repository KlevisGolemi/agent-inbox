# Changelog

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) · versionnage [SemVer](https://semver.org/lang/fr/).

## [Unreleased]

## [2.0.0] - 2026-10-01

Réécriture complète : une seule application TypeScript, authentification OAuth 2.1, réglages à chaud.
L'API HTTP des producteurs (`/webhook`, `/next`, `/peek`…) reste compatible avec la v1.

### Breaking

- **URL MCP** : `/t/<jeton>/mcp` devient `/mcp`. L'accès se fait par OAuth 2.1 (email et mot de passe
  du compte administrateur) ou par clé API `cwk_…` ; le jeton dans l'URL (`MCP_TOKEN`) n'existe plus.
- **Services fusionnés** : les deux services de la v1 (file et serveur MCP) forment un seul conteneur
  `app` et un seul volume. `DOMAIN`, `MCP_DOMAIN` et `MCP_TOKEN` sont remplacées par `PUBLIC_URL` (et `SITE_HOST` pour Caddy).
  L'interface d'administration passe de `/t/<jeton>/ui` à `/admin` (connexion requise).
- **`queue_by_id`** consulte le message sans le consommer par défaut (`peek: true`) ; `peek: false` l'emprunte.
- **Consommation côté MCP** : `queue_next`, `queue_wait` et `queue_by_id(peek: false)` empruntent le message
  (statut `leased`) ; il faut l'acquitter avec `queue_ack`. Sans acquittement, il est servi à nouveau
  après `lease_timeout_sec` (300 s par défaut). Côté HTTP, `GET /next` consomme toujours directement,
  sauf avec `?ack=manual`.
- **Variables de la v1** : `WEBHOOK_SECRET`, `TTL_HOURS` et `CLEANUP_INTERVAL_MIN` ne sont lues qu'une
  fois, comme valeurs initiales ; elles se gèrent ensuite dans l'interface. `WEBHOOK_SECRET` doit contenir
  au moins 32 caractères, sinon l'application refuse de démarrer.

### Ajouté

- Serveur MCP sans état (12 outils) : il survit aux redémarrages du conteneur.
- OAuth 2.1 (enregistrement dynamique des clients, PKCE), clés API révocables, page de consentement.
- Compte administrateur : code de setup au premier lancement, `create-admin`, `reset-password`.
- Topics (`x-topic`), bail avec `ack` / `nack`, attente longue (`wait`), recherche (`/search`, `queue_search`).
- Réglages modifiables à chaud : TTL global et par topic, limite de débit, secret du webhook, bail, sauvegardes.
- Sauvegardes planifiées, téléchargement et restauration depuis l'interface.
- Mise à jour : vérification des releases GitHub, bouton « Mettre à jour » (sidecar `updater`, optionnel).
- `install.sh` (Caddy par défaut, Traefik existant, sslip.io sans domaine), `update.sh`, `uninstall.sh`.
- Variable `TRUST_PROXY` pour la limite de débit derrière un ou plusieurs proxys.
- CI GitHub Actions, image Docker multi-architecture (`ghcr.io/klevisgolemi/cowork-queue`), releases.
- Templates n8n importables (`examples/n8n/`) et documentation complète.

### Sécurité

- Limites de débit : 600 requêtes par minute et par IP sur `POST /mcp` et `GET /next` ; 100 attentes longues
  simultanées au plus (`429 too_many_waiters`). `x-source` limité à 100 caractères.
- Changer le mot de passe administrateur (interface ou `reset-password`) révoque les jetons OAuth du compte.
- Page d'administration servie avec une CSP restrictive ; scripts CDN vérifiés par SRI.
- `lease_id` n'est renvoyé qu'à l'emprunt (absent de `peek`, `search` et des consultations).
- Arrêt propre : les attentes longues se terminent aussitôt (`stop_grace_period: 20s`).

### Supprimé

- `server.js`, `mcp/`, `poll.sh`, `API_REFERENCE.md` et `COWORK_INSTRUCTIONS.md` (code et documentation de la v1).

[Unreleased]: https://github.com/KlevisGolemi/cowork-communication/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/KlevisGolemi/cowork-communication/releases/tag/v2.0.0
