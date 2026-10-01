# CLAUDE.md

Guide pour Claude Code sur ce dépôt. Procédure d'installation et guide de contribution complets : [AGENTS.md](AGENTS.md).

## Vue d'ensemble

Cowork Queue : file d'attente auto-hébergée. Des producteurs (n8n, scripts) déposent des messages en HTTP
(`POST /webhook`), Claude et ChatGPT les lisent et en écrivent via MCP (`POST /mcp`, 12 outils). Une seule
application TypeScript (Node 24, Express 5, better-sqlite3), un conteneur, une base SQLite (`/data/queue.db`).
Authentification : secret partagé pour l'API HTTP, OAuth 2.1 ou clé API `cwk_…` pour MCP, session par cookie
pour `/admin`. Version courante : 2.x ; la v1 (`server.js`, `mcp/`) n'existe plus.

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
- `mcp/` : `server.ts` (transport sans état), `tools.ts` (les 12 outils).
- `auth/` : utilisateurs, sessions, CSRF, clés API, middleware Bearer, pages ; `oauth/` : serveur OAuth 2.1.
- `admin/routes.ts` : API d'administration. `settings/` : réglages en base. `db/` : migrations versionnées.
- `jobs/` (nettoyage, sauvegardes), `backups/`, `version/` (releases GitHub).
- Hors `src/` : `public/` (interface), `deploy/` (Caddy, Traefik, updater), `test/`, `docs/`, `examples/n8n/`.

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

## Communication

Réponses concises : l'essentiel, le plan, les décisions ; pas de pavés. L'utilisateur dicte souvent à l'oral : reformuler et poser des questions quand c'est ambigu. Éviter l'over-engineering.
