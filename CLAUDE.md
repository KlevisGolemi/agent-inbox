# CLAUDE.md

Guide pour Claude Code sur ce dépôt. Procédure d'installation et guide de contribution complets : [AGENTS.md](AGENTS.md).

## Vue d'ensemble

Agent Inbox : file d'attente auto-hébergée. Des producteurs (n8n, scripts, tiers via drop) déposent des
messages et des fichiers en HTTP (`POST /webhook`, `POST /d/:token`), Claude et ChatGPT les lisent et en
écrivent via MCP (`POST /mcp`, 20 outils). Une seule application TypeScript (Node 24, Express 5,
better-sqlite3), un conteneur, une base SQLite (`/data/queue.db`) et des fichiers sur disque (`/data/files`).
Authentification : secret partagé pour l'API HTTP, OAuth 2.1 ou clé API `aik_…` pour MCP, session par cookie
pour `/admin`. Version courante : 2.2.0 ; la v1 (`server.js`, `mcp/`) n'existe plus.

## Commandes

```bash
npm ci
npm run dev:ui      # http://localhost:3000/admin, base dans .dev/ (identifiants de développement local uniquement, définis dans scripts/dev-server.ts)
npm run check       # eslint + tsc --noEmit + vitest : à passer avant chaque commit
npm test            # vitest run
npm run build       # build:css (Tailwind → public/app.css) puis tsc → dist/
npm run format      # prettier --write .
./install.sh        # installation Docker (Caddy ou Traefik) ; update.sh, uninstall.sh
```

## Carte de `src/`

- `index.ts`, `bootstrap.ts` : démarrage et assemblage des dépendances (`buildRuntime`, aussi utilisé par les tests et `dev:ui`) ;
  `shutdown.ts` : arrêt propre (attentes longues résolues, sortie forcée après 15 s). `zod.ts` : messages zod en français.
- `env.ts` : variables d'environnement (zod). `app.ts` : assemblage Express. `cli.ts` : `create-admin`, `reset-password`.
- `queue/` : `repo.ts` (SQLite), `routes.ts` (API HTTP), `http.ts` (vues, attente `wait`, filtres), `validation.ts` (regex).
- `files/` : stockage disque (`store.ts`), détection MIME (`detect.ts`), multipart (`multipart.ts`), uploads (`uploads.ts`),
  pièces jointes (`attachments.ts`), liens signés (`links.ts`), routes (`routes.ts`).
- `tags/` : registre (`registry.ts`), similarité/normalisation (`similarity.ts`), pose sur messages (`attach.ts`).
- `drops/` : service de création (`service.ts`), page publique (`page.ts`), routes (`routes.ts`), repository (`repo.ts`).
- `mcp/` : `server.ts` (transport sans état), `tools.ts` (les 20 outils), `tagTools.ts`, `fileTools.ts`, `dropTools.ts`.
- `auth/` : utilisateurs, sessions, CSRF, clés API, middleware Bearer, pages ; `oauth/` : serveur OAuth 2.1.
- `admin/routes.ts` : API d'administration. `settings/` : réglages en base. `db/` : migrations versionnées.
- `jobs/` (nettoyage, sauvegardes), `backups/`, `version/` (releases GitHub).
- Hors `src/` : `public/` (interface), `deploy/` (Caddy, Traefik, updater), `skills/`, `test/`, `docs/`, `examples/n8n/`.

## Invariants

- **Claim atomique** : un seul `UPDATE … RETURNING` pour prendre un message ; jamais `SELECT` puis `UPDATE`.
- **Regex unique** : `CORRELATION_ID_REGEX` et `TOPIC_REGEX` sont définies dans `src/queue/validation.ts` seulement.
- **Réglages en base, relus à chaud** : `settings.get()` à chaque usage, jamais mis en cache dans une constante.
- **MCP sans état** : un serveur et un transport par `POST /mcp`, aucune session en mémoire.
- **Bail et `queue_ack`** : consommer côté MCP emprunte le message ; `lease_id` = `<uuid>.<attempts>`.
- **`correlation_id` unique** dans toute la file (index unique partiel) ; `queue_by_id` consulte par défaut (`peek: true`).
- **Aucun secret dans les logs** : `log()` ne reçoit ni secret, ni jeton, ni payload (exception : le code de setup).
- **`TRUST_PROXY`** : nombre exact de proxys de confiance ; ne jamais publier le port de l'application.
- **Migrations** : on en ajoute, on ne modifie pas les existantes.
- **Un test par changement** (Vitest + Supertest) et documentation à jour (`docs/`, `CHANGELOG.md`).
- **FileStore seul propriétaire du disque** : suppression = marquer `deleted_at` en base puis effacer les
  fichiers après le commit. Jamais de cascade SQL seule.
- **Tags créés dans la transaction d'enqueue** : `queue_send.new_tags`, `queue_tag.new_tags` et créations
  automatiques HTTP sont insérés dans la même transaction que le message, sans orphelin.
- **Lingering close après erreur d'upload** : pour une requête authentifiée dont le corps est en cours
  d'envoi, `Connection: close` puis lecture et rejet du reste (`lingerAfterError`), avec bornes de temps,
  d'octets et de sockets simultanés. Derrière Caddy/Traefik, c'est la connexion proxy → app qui est gérée
  (hop-by-hop).

## Production (instance de l'auteur)

- VPS : `ssh vps-hostinger`, projet dans `/opt/agent-inbox` (clone git de `main`), conteneur `agent-inbox-app-1`.
- Topologie : Cloudflare (proxy) → Traefik en `network_mode: host` (pas de réseau partagé) → app. D'où
  `COMPOSE_FILE=deploy/docker-compose.traefik.yml`, `TRUST_PROXY=2`, `TRAEFIK_RULE` sur `queue.` et `mcp.igk-digital.cloud`.
- Données : volume historique `webhook-queue_queue_data` (`QUEUE_VOLUME_NAME`), propriétaire uid 1000 (utilisateur `node`).
- Déployer : `git pull --ff-only` → `docker compose build app` (l'ancien conteneur tourne encore) → `docker compose up -d app`
  → vérifier `/healthz` sur les deux domaines, le `401` + `WWW-Authenticate` de `POST /mcp`, et un aller-retour `/webhook`.
- Sauvegardes manuelles avant toute migration : `/root/backups/` (tar du volume + copie du `.env`).

## Pièges connus

- **Ne jamais nommer le produit ni un connecteur « Cowork… »** : Claude Desktop rejette silencieusement les connecteurs
  dont le nom commence par ce préfixe réservé (log `~/Library/Logs/Claude/main.log` : « collides with a trusted internal
  server prefix »). C'est la raison du renommage en Agent Inbox (2.1.0).
- Un connecteur MCP ajouté pendant une session n'apparaît que dans une **nouvelle** session.
- Le **code de setup** change à chaque démarrage tant qu'aucun compte admin n'existe : prendre la dernière ligne des logs.
- Tests : `test/setup/loopback-listen.ts` force Supertest sur `127.0.0.1` ; sans lui, sur macOS, un port éphémère déjà tenu
  par un autre service (Ollama sur 49152) répond à la place du serveur de test → tests instables.
- `.env` : `TRAEFIK_RULE` contient des backticks ; ne pas l'écrire via un heredoc non quoté (le shell les exécute).
- `better-sqlite3` est compilé sans URI SQLite : pas de `file:…?mode=ro` ; vérifier l'existence du fichier avant `ATTACH`.
- Ne jamais stocker ni utiliser une clé API collée dans la conversation : la faire révoquer et passer par le connecteur MCP.

## Communication

Réponses concises : l'essentiel, le plan, les décisions ; pas de pavés. L'utilisateur dicte souvent à l'oral : reformuler et poser des questions quand c'est ambigu. Éviter l'over-engineering.
