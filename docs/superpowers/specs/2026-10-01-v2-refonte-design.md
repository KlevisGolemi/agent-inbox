# Cowork Queue v2 — Design

- **Date** : 2026-10-01
- **Statut** : validé, prêt pour le plan d'implémentation
- **Version cible** : `2.0.0` (breaking : URL MCP et auth)

## 1. Contexte et objectif

Cowork Queue est une file d'attente auto-hébergée qui relie des automatisations (n8n, scripts, outils sans MCP)
à des assistants IA (Claude, ChatGPT) via MCP. Un producteur pousse des événements, l'assistant les récupère
et en tire quelque chose.

La v1 fonctionne côté HTTP mais est **inutilisable depuis les clients Claude** : les sessions MCP sont gardées
en mémoire, perdues à chaque redémarrage, et le serveur répond `400` au lieu de `404` sur session inconnue,
donc le client ne se ré-initialise jamais (connecteur visible, zéro outil).

La v2 doit :

1. Fonctionner de façon fiable avec Claude (Desktop, Web, Cowork, Code) et ChatGPT.
2. Offrir une authentification simple (email + mot de passe) via OAuth 2.1, plus des clés API.
3. Rendre tous les réglages modifiables à chaud, sans redémarrage.
4. S'installer en une commande, avec ou sans nom de domaine.
5. Être un repo exemplaire : structure lisible, tests, CI, releases, documentation claire pour un humain
   comme pour un agent IA.

**Critères de succès**

- Un connecteur ajouté dans Claude Web/Desktop liste les 8 outils, et continue de fonctionner après un redémarrage du conteneur.
- Un utilisateur sans domaine installe et connecte l'instance en moins de 10 minutes en suivant le README.
- Un agent IA à qui l'on donne `AGENTS.md` mène l'installation à bout sans improviser.
- Modifier le TTL dans l'UI prend effet au prochain cycle de nettoyage, sans redémarrage.
- Les workflows n8n existants continuent de fonctionner sans modification.

**Hors périmètre** : refonte visuelle de l'UI (adaptation à la nouvelle auth uniquement), multi-comptes,
backend Supabase, fournisseurs d'identité tiers (Google, Microsoft).

## 2. Architecture

Fusion des deux services v1 (`webhook-queue` + `cowork-mcp`) en **une seule application TypeScript**,
un seul conteneur, une seule base SQLite.

```
 n8n / scripts ──x-webhook-secret──▶ ┌──────────────────────────────┐
                                     │  cowork-queue (Node 24, TS)  │
 Claude / ChatGPT ──OAuth 2.1──────▶ │  /webhook /next /peek …      │──▶ SQLite (/data/queue.db)
 Agents / CI ──Bearer cwk_…───────▶  │  /mcp   /oauth/*  /admin     │
                                     └──────────────────────────────┘
                  HTTPS : Caddy (défaut) ou Traefik existant
```

### Stack

Node 24 LTS · TypeScript (strict) · Express 5 · better-sqlite3 · `@modelcontextprotocol/sdk` (dernière 1.x) · zod ·
Vitest + Supertest. Hachage des mots de passe via `node:crypto` `scrypt` (aucune dépendance ajoutée).

### Arborescence

```
src/
  index.ts            bootstrap : env, DB, app, jobs, arrêt propre
  app.ts              assemblage Express (testable sans écouter de port)
  env.ts              lecture + validation zod des variables de démarrage
  db/                 connexion, migrations versionnées (PRAGMA user_version)
  settings/           réglages en base : lecture typée, validation, cache invalidé à l'écriture
  queue/              repository (requêtes préparées) + routes HTTP compatibles v1
  mcp/                serveur MCP stateless + définition des outils
  auth/               utilisateur, sessions admin, provider OAuth, clés API, middleware Bearer
  admin/              API REST d'admin + service de l'UI statique
  jobs/               nettoyage TTL et jetons expirés
  version/            version courante, vérification des releases GitHub
public/               UI d'admin (Alpine.js, adaptée à la nouvelle auth)
test/                 tests Vitest par module
deploy/               Caddyfile, compose Traefik, script updater
docs/                 installation, connexion des clients, API, specs
```

Chaque module expose une interface étroite (`createQueueRepo(db)`, `createSettings(db)`, …) et reçoit ses dépendances
en paramètre : pas d'état global, tests unitaires sans serveur.

## 3. Données

Migrations versionnées via `PRAGMA user_version`, appliquées au démarrage dans une transaction.
La migration 1 reprend le schéma v1 tel quel (base existante compatible) ; les suivantes ajoutent :

| Table | Contenu |
|---|---|
| `messages` | inchangée (id, source, payload, status, created_at, read_at, correlation_id + index unique partiel) |
| `settings` | `key` TEXT PK, `value` TEXT (JSON), `updated_at` |
| `users` | un seul admin : email, `password_hash` (scrypt + sel), created_at |
| `admin_sessions` | id (haché), user_id, expires_at — cookie de l'UI |
| `oauth_clients` | clients enregistrés dynamiquement (DCR) : client_id, metadata JSON, created_at |
| `oauth_codes` | codes d'autorisation (hachés), client_id, PKCE challenge, redirect_uri, scopes, expires_at |
| `oauth_tokens` | access/refresh tokens (hachés), type, client_id, scopes, expires_at, revoked |
| `api_keys` | nom, préfixe affichable, hash, created_at, last_used_at, revoked |

Tous les secrets (jetons, codes, clés, sessions) sont stockés **hachés en SHA-256** ; seul le préfixe d'une clé API
est affichable après création.

## 4. Réglages à chaud

| Réglage | Défaut | Notes |
|---|---|---|
| `ttl_hours` | 48 | rétention des messages |
| `cleanup_interval_min` | 60 | relu à chaque cycle (`setTimeout` replanifié, pas `setInterval`) |
| `webhook_rate_limit_per_min` | 100 | lu par requête par le limiteur |
| `webhook_secret` | généré | rotation depuis l'UI, effet immédiat |
| `update_check_enabled` | true | interroge les releases GitHub (cache 6 h) |

- Le module `settings` valide chaque valeur avec zod (bornes min/max), garde un cache mémoire invalidé à l'écriture.
- Au premier démarrage, les valeurs v1 présentes dans l'environnement (`TTL_HOURS`, `WEBHOOK_SECRET`, …) servent de
  **graine** puis la base fait foi. Cela assure la migration sans perte de la prod v1.
- Restent dans l'environnement uniquement : `PUBLIC_URL`, `PORT`, `DB_PATH`, `ADMIN_EMAIL`/`ADMIN_PASSWORD` (optionnels).

## 5. Authentification

### Premier lancement

- Aucun utilisateur en base → `/setup` affiche un formulaire email + mot de passe (12 caractères min).
- Protection : un **code de setup à usage unique** est écrit dans les logs au démarrage et exigé par le formulaire.
- Alternative non interactive : `ADMIN_EMAIL` + `ADMIN_PASSWORD` dans l'env créent le compte au boot.
- Réinitialisation : commande `docker compose exec app node dist/cli.js reset-password`.

### Mode 1 — OAuth 2.1 (clients IA)

Implémenté via le routeur d'auth du SDK MCP (`mcpAuthRouter`) et un `OAuthServerProvider` maison adossé à SQLite :

- Métadonnées : `/.well-known/oauth-authorization-server` et `/.well-known/oauth-protected-resource`.
- Enregistrement dynamique des clients (DCR), code d'autorisation + **PKCE obligatoire**.
- L'écran `/oauth/authorize` réutilise la session admin ; sinon formulaire de login, puis écran de consentement
  (« Claude souhaite accéder à votre queue »).
- Access token 1 h, refresh token 30 jours avec rotation.
- `/mcp` répond `401` + en-tête `WWW-Authenticate` pointant vers les métadonnées, ce qui déclenche le flux côté client.

### Mode 2 — Clés API

- Créées / révoquées dans l'UI, format `cwk_<32 caractères>`, affichées une seule fois.
- Acceptées sur `/mcp` via `Authorization: Bearer cwk_…`. Usage : scripts, CI, Claude Code headless,
  clients sans OAuth.

### Middleware unique

`requireBearer` vérifie dans l'ordre : préfixe `cwk_` → table `api_keys`, sinon → table `oauth_tokens`.
Comparaisons sur hash ; `last_used_at` mis à jour au plus une fois par minute.

### API de la file (n8n)

Inchangée : `x-webhook-secret`, comparé à temps constant au secret **lu en base**.

### Protections

Rate limit sur `/oauth/token`, `/login` et `/setup` (10 req/min/IP). Cookies `HttpOnly; Secure; SameSite=Lax`.
CORS limité à `/mcp` et aux métadonnées OAuth. En-têtes de sécurité de base (`nosniff`, `frame-ancestors 'none'`).

## 6. Serveur MCP

- **Stateless** : un `McpServer` + `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) par requête.
  Aucun état en mémoire : un redémarrage n'interrompt aucun client et il n'y a plus de sessions à nettoyer.
- `GET` et `DELETE` sur `/mcp` → `405` (pas de flux serveur en mode stateless).
- Outils (8, inchangés fonctionnellement) appelant **directement** le repository, sans aller-retour HTTP :

| Outil | Annotations |
|---|---|
| `queue_status`, `queue_stats` | `readOnlyHint` |
| `queue_peek` (+ `limit`, `offset`) | `readOnlyHint` |
| `queue_by_id` (`peek` par défaut `true`) | destructif seulement si `peek=false` |
| `queue_next` | `destructiveHint` |
| `queue_send` | écriture, non destructif |
| `queue_delete`, `queue_clear` | `destructiveHint` |

- Changement de comportement assumé : `queue_by_id` lit sans consommer par défaut (aligné sur l'admin API),
  la consommation devient explicite.
- Les erreurs métier renvoient `isError: true` avec un message lisible par le modèle.

## 7. Nettoyage

Un seul job `jobs/cleanup`, replanifié après chaque exécution avec l'intervalle lu en base :

- messages lus depuis plus de `ttl_hours`, et messages pending plus vieux que `ttl_hours` ;
- codes OAuth, tokens et sessions admin expirés ou révoqués ;
- `PRAGMA optimize` après chaque passe ; `VACUUM` uniquement depuis l'UI (action manuelle).

## 8. Versions et mises à jour

- Version unique : `package.json`, exposée par `/healthz` et l'UI.
- `version/` interroge `api.github.com/repos/<owner>/<repo>/releases/latest` (cache 6 h, désactivable).
- L'UI affiche « v2.0.0 installée · v2.1.0 disponible » + notes de release.
- Bouton « Mettre à jour » :
  - **profil compose `updater` désactivé par défaut** : petit conteneur ayant accès au socket Docker, qui expose
    un unique endpoint interne authentifié par un secret partagé et exécute `docker compose pull && up -d` ;
  - sans ce profil, le bouton affiche la commande `./update.sh` à lancer sur le serveur.
- La documentation explique clairement le compromis de sécurité du socket Docker.

## 9. Déploiement

- **Image** publiée sur GHCR par GitHub Actions à chaque tag `v*` (multi-arch amd64/arm64).
- `docker-compose.yml` par défaut : `app` + **Caddy** (HTTPS automatique). `PUBLIC_URL` détermine l'hôte.
  - Avec domaine : `PUBLIC_URL=https://queue.mondomaine.com`.
  - Sans domaine : `PUBLIC_URL=https://<ip-avec-tirets>.sslip.io` (certificat Let's Encrypt réel ; Claude et
    ChatGPT exigent HTTPS).
- `deploy/docker-compose.traefik.yml` : variante pour un Traefik existant, avec possibilité de router plusieurs
  hôtes vers l'app (cas de la prod actuelle : `queue.` et `mcp.igk-digital.cloud`).
- `install.sh` : vérifie les prérequis, demande domaine ou IP, choisit Caddy ou Traefik, génère le `.env`,
  démarre, affiche l'URL de setup et le code à usage unique.
- `update.sh`, `uninstall.sh` conservés et alignés.
- Conteneur non-root, healthcheck sur `/healthz`, arrêt propre sur SIGTERM (fermeture HTTP puis DB).

## 10. Qualité

- TypeScript strict, ESLint + Prettier, `npm run check` = lint + typecheck + tests.
- Tests Vitest (base SQLite en mémoire) :
  - queue : FIFO, claim atomique concurrent, correlation_id (400/404/409/410), pagination ;
  - settings : validation, prise en compte à chaud (TTL, rate limit, secret) ;
  - auth : setup, login, flux OAuth complet avec PKCE, refresh, révocation, clés API ;
  - MCP : `initialize` + `tools/list` + appel d'outil sans session, 401 sans jeton ;
  - migrations : base v1 réelle → v2 sans perte.
- CI GitHub Actions : `check` sur chaque PR, build + publication d'image sur tag.
- Conventional Commits, `CHANGELOG.md`, releases GitHub.
- Logs JSON structurés, jamais de secret dans les logs.

## 11. Documentation

| Fichier | Public | Contenu |
|---|---|---|
| `README.md` | tous | pitch, schéma, captures, démarrage en 5 min, cas d'usage |
| `docs/installation.md` | humains | domaine, IP seule (sslip.io), Traefik existant, mise à jour, désinstallation |
| `docs/connecter-un-client.md` | humains | Claude Desktop/Web/Cowork, Claude Code, ChatGPT, clé API — avec captures |
| `docs/api.md` | devs | API HTTP de la file (fusion de `API_REFERENCE.md`) + exemples n8n |
| `docs/cas-d-usage.md` | tous | recettes : événement n8n → Claude, request-response par correlation_id |
| `AGENTS.md` | agents IA | procédure d'installation déterministe, étape par étape, avec vérifications |
| `CLAUDE.md` | Claude Code | architecture, commandes, contraintes, règle « réponses concises » |
| `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (MIT) | communauté | standards du repo |

`COWORK_INSTRUCTIONS.md` et `API_REFERENCE.md` sont absorbés dans `docs/` puis supprimés.

## 12. Migration de la prod actuelle

1. Sauvegarde du volume `queue_data`.
2. Déploiement v2 avec la variante Traefik, routant `queue.` et `mcp.igk-digital.cloud` vers l'app.
3. Au boot : migrations du schéma, `WEBHOOK_SECRET` et `TTL_HOURS` du `.env` copiés en base.
4. Setup du compte admin, puis reconnexion du connecteur Claude sur `https://mcp.igk-digital.cloud/mcp`.
5. Vérification : un `POST /webhook` depuis n8n, puis `queue_peek` depuis Claude.

Rollback : redéployer l'image v1 avec la sauvegarde du volume.

## 13. Risques

| Risque | Mitigation |
|---|---|
| Spécificités OAuth propres à chaque client (Claude vs ChatGPT) | tests manuels documentés sur chaque client avant release |
| Prise de contrôle de `/setup` avant l'admin | code de setup à usage unique dans les logs |
| Socket Docker de l'updater = accès root à l'hôte | désactivé par défaut, documenté |
| Migration de la base de prod | sauvegarde + test de migration sur une copie de la base v1 |
