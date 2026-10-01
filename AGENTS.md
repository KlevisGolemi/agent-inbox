# AGENTS.md

Instructions pour un agent IA (Claude Code, Codex, etc.). Deux parties : [installer et connecter](#installer-cowork-queue)
une instance pour un utilisateur, puis [contribuer au code](#contribuer-au-code).

## Installer Cowork Queue

Suivez les étapes dans l'ordre. Après chaque étape, exécutez la vérification et comparez avec la sortie
attendue ; en cas d'écart, passez à [Si ça échoue](#5-si-ça-échoue). N'improvisez pas d'autres commandes.

### 1. Demander à l'utilisateur

| Question | Détermine |
|---|---|
| Un nom de domaine pointe-t-il vers le serveur ? Lequel ? Sinon, quelle est l'**IP publique** ? | `CQ_PUBLIC_URL` (domaine, URL ou IPv4 ; une IPv4 devient `<ip-avec-tirets>.sslip.io`) |
| Un **Traefik** tourne-t-il déjà sur ce serveur ? | `CQ_MODE` : `caddy` (défaut, inclus) ou `traefik` |
| Si Traefik : sous quels domaines ? Dans un réseau Docker nommé (lequel) ou en mode host ? Un certresolver autre que `letsencrypt` ? | `CQ_TRAEFIK_HOSTS`, `CQ_TRAEFIK_NETWORK`, `CQ_TRAEFIK_CERTRESOLVER` |
| Le domaine passe-t-il par **Cloudflare** (proxy orange) ? (Traefik seulement) | `CQ_BEHIND_CLOUDFLARE=1` |
| Quel **e-mail** pour le compte administrateur ? | `CQ_ADMIN_EMAIL` |
| Activer la **mise à jour en un clic** ? Lui expliquer le risque : le service monte le socket Docker (accès root à l'hôte). | `CQ_UPDATER=yes` ou `no` |

**Mot de passe administrateur** : ne le demandez pas dans la conversation et ne le stockez pas. Laissez
`CQ_ADMIN_EMAIL` et `CQ_ADMIN_PASSWORD` vides : l'utilisateur crée son compte lui-même avec le code de setup (étape 3).
Si l'utilisateur insiste pour que vous le fassiez, passez les deux variables, sachant que le mot de passe
transite alors par l'environnement du shell.

Prérequis à confirmer sur le serveur : `docker`, `docker compose` (v2), `openssl`, `curl`, ports 80 et 443
libres (Caddy) et joignables, enregistrement DNS créé (inutile avec une IP).

### 2. Installer

```bash
git clone https://github.com/KlevisGolemi/cowork-communication.git
cd cowork-communication
CQ_YES=1 CQ_PUBLIC_URL=<domaine-ou-ip> ./install.sh
```

Variables `CQ_*` reconnues par `install.sh` (toutes facultatives sauf `CQ_PUBLIC_URL`) :

| Variable | Valeurs | Défaut |
|---|---|---|
| `CQ_YES` | `1` : aucune question, valeurs par défaut | interactif |
| `CQ_PUBLIC_URL` | domaine, URL ou IPv4 | (obligatoire en mode non interactif) |
| `CQ_MODE` | `caddy` \| `traefik` | `caddy` |
| `CQ_TRAEFIK_HOSTS` | domaines séparés par des virgules | l'hôte de `CQ_PUBLIC_URL` |
| `CQ_TRAEFIK_NETWORK` | nom d'un réseau Docker existant | aucun (Traefik en mode host) |
| `CQ_TRAEFIK_CERTRESOLVER` | nom du certresolver | `letsencrypt` |
| `CQ_BEHIND_CLOUDFLARE` | `1` : `TRUST_PROXY=2` | `0` (`TRUST_PROXY=1`) |
| `CQ_ADMIN_EMAIL`, `CQ_ADMIN_PASSWORD` | ensemble, mot de passe de 12 caractères minimum | aucun compte créé |
| `CQ_UPDATER` | `yes` \| `no` | `no` |

Exemples :

```bash
# Caddy, domaine
CQ_YES=1 CQ_PUBLIC_URL=queue.example.com ./install.sh
# Caddy, IP seule (sslip.io)
CQ_YES=1 CQ_PUBLIC_URL=203.0.113.10 ./install.sh
# Traefik existant (réseau partagé), derrière Cloudflare
CQ_YES=1 CQ_MODE=traefik CQ_PUBLIC_URL=queue.example.com CQ_TRAEFIK_NETWORK=traefik_proxy CQ_BEHIND_CLOUDFLARE=1 ./install.sh
```

Le script refuse d'écraser un `.env` existant (sauf `--force`, après sauvegarde du fichier). Il écrit `.env`
(droits 600), lance `docker compose up -d`, attend `/healthz` (120 s max) puis affiche les adresses.

**Vérifier** (remplacez `$URL` par l'URL affichée, sans barre finale) :

```bash
docker compose ps                  # app : "healthy" ; caddy : "running" (ou rien d'autre en mode Traefik)
curl -fsS "$URL/healthz"           # {"ok":true,"uptime_s":<n>,"version":"2.0.0"}
curl -si -X POST "$URL/mcp" | head -n 8   # HTTP/… 401 et un en-tête WWW-Authenticate: Bearer … resource_metadata=…
```

### 3. Créer le compte administrateur

Si aucun compte n'a été créé par le script :

```bash
docker compose logs app | grep -i setup
```

Donnez à l'utilisateur l'adresse `$URL/setup` et le code affiché (6 groupes de 4 caractères) : il choisit
lui-même son e-mail et son mot de passe. **Vérifier** : l'utilisateur atteint `$URL/admin` après connexion.

### 4. Connecter le client

Donnez à l'utilisateur l'adresse MCP **`$URL/mcp`** (elle doit se terminer par `/mcp`) et suivez
[docs/connecter-un-client.md](docs/connecter-un-client.md) :

- **Claude (Web, Desktop, Cowork)** : Paramètres → Connecteurs → Ajouter un connecteur personnalisé, puis connexion et consentement.
- **Claude Code** : `claude mcp add --transport http cowork-queue $URL/mcp`, puis `/mcp` pour s'authentifier.
- **ChatGPT** : connecteur MCP personnalisé en mode développeur, authentification OAuth.
- **Autre client / automatisation** : clé API créée par l'utilisateur dans Admin → Connexions
  (`Authorization: Bearer cwk_…`). Ne créez pas de clé à sa place sans qu'il le demande.

**Vérifier** : le client liste **12 outils** (`queue_status`, `queue_stats`, `queue_peek`, `queue_search`,
`queue_by_id`, `queue_next`, `queue_wait`, `queue_ack`, `queue_nack`, `queue_send`, `queue_delete`,
`queue_clear`) et `queue_status` répond `ok: true`.

### 5. Si ça échoue

| Constat | Action |
|---|---|
| `install.sh` : « Un fichier .env existe déjà » | Arrêtez-vous et demandez : l'installation existe peut-être. `--force` écrase `.env` ; ne l'utilisez qu'avec l'accord de l'utilisateur, après `cp .env .env.bak`. |
| `install.sh` : « Le service ne répond pas sur /healthz » | `docker compose logs --tail=80 app`. Une erreur `Configuration invalide : …` nomme la variable fautive. |
| `/healthz` répond en local, pas depuis l'extérieur | DNS (`dig +short <hôte>`), ports 80/443, pare-feu ; `docker compose logs caddy` pour le certificat. Attendre une minute après un changement DNS. |
| `/mcp` ne renvoie pas 401 + `WWW-Authenticate` | Le proxy ne route pas vers l'application. Vérifier l'URL, `SITE_HOST`, `TRAEFIK_RULE`, le réseau Traefik. |
| Connecteur visible sans outils | L'URL ne se termine pas par `/mcp`, ou la vérification ci-dessus échoue. Supprimer et rajouter le connecteur. |
| Code de setup introuvable | `docker compose restart app` en génère un nouveau, puis relire les logs. |
| Mot de passe oublié | `docker compose exec app node dist/cli.js reset-password <email>` (l'utilisateur saisit le mot de passe). |

Ne publiez jamais le port 3000 de l'application et ne modifiez pas `TRUST_PROXY` sans en comprendre
la raison ([docs/installation.md](docs/installation.md#ne-publiez-jamais-le-port-de-lapplication)).
Au-delà de ces cas, voir le [dépannage](docs/installation.md#dépannage) et demandez à l'utilisateur avant de continuer.

---

## Contribuer au code

Node.js 24 ou plus, TypeScript strict, Express 5, better-sqlite3, zod, Vitest. Une seule application,
un conteneur, une base SQLite.

### Commandes

```bash
npm ci
npm run dev:ui      # serveur de développement : http://localhost:3000/admin (base dans .dev/)
npm run check       # eslint + tsc --noEmit + vitest : à passer avant tout commit
npm test            # vitest run (test:watch pour la boucle courte)
npm run lint        # eslint .
npm run typecheck   # tsc --noEmit
npm run format      # prettier --write .
npm run build       # Tailwind (public/app.css) puis tsc → dist/
```

### Carte du code

| Chemin | Rôle |
|---|---|
| `src/index.ts`, `src/bootstrap.ts`, `src/shutdown.ts` | Démarrage, assemblage des dépendances (`buildRuntime`, partagé avec les tests et `dev:ui`), arrêt propre |
| `src/env.ts` | Variables d'environnement validées (zod) |
| `src/app.ts` | Assemblage Express (testable sans port) |
| `src/queue/` | `repo.ts` (SQLite, requêtes préparées), `routes.ts` (API HTTP), `http.ts` (vues, `wait`, filtres), `validation.ts` (regex) |
| `src/mcp/` | `server.ts` (transport sans état, CORS), `tools.ts` (les 12 outils) |
| `src/auth/` | Comptes, sessions, CSRF, clés API, middleware Bearer, pages de connexion ; `oauth/` : serveur OAuth 2.1 (SDK MCP) |
| `src/admin/routes.ts` | API d'administration (`/admin/api/*`) |
| `src/settings/` | Réglages en base (bornes zod, cache, graines) |
| `src/db/` | Connexion et migrations versionnées (`PRAGMA user_version`) |
| `src/jobs/`, `src/backups/`, `src/version/` | Nettoyage, sauvegardes, vérification des releases |
| `src/cli.ts` | `create-admin`, `reset-password` |
| `public/` | Interface d'administration (HTML unique, Alpine.js ; `app.css` est généré) |
| `deploy/` | Caddyfile, variantes Traefik, sidecar `updater` |
| `test/` | Un fichier de test par module ; `helpers/app.ts` construit une application en mémoire |

### Invariants (ne pas casser)

- **Claim atomique** : lire un message = un seul `UPDATE … RETURNING` (`claimNext`, `claimByCorrelation`),
  jamais un `SELECT` puis un `UPDATE`.
- **Regex unique** : `CORRELATION_ID_REGEX` et `TOPIC_REGEX` ne se définissent que dans `src/queue/validation.ts`.
- **Réglages en base** : tout réglage modifiable passe par `settings.get()` à chaque usage (jamais copié dans
  une variable de module) pour que les changements soient pris à chaud. Ajouter un réglage = entrée dans
  `SETTINGS` et `DEFAULTS`, test, documentation.
- **MCP sans état** : chaque `POST /mcp` crée son serveur et son transport ; aucune session en mémoire.
- **Bail et acquittement** : l'emprunt incrémente `attempts` ; `lease_id` = `<uuid>.<attempts>`.
- **Pas de secret dans les logs** : `log()` n'écrit ni secret, ni jeton, ni payload (seule exception : le code de setup).
- **`TRUST_PROXY`** : l'adresse du client (`req.ip`) dépend de lui ; l'application ne doit jamais être exposée sans proxy.
- **Migrations** : ajoutez une migration, ne modifiez jamais une migration existante.

### Conventions

- Commits : Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- Un test pour chaque correctif ou fonctionnalité (Vitest + Supertest, base SQLite en mémoire).
- Commentaires et messages utilisateur en français ; identifiants de code en anglais ; pas de dépendance ajoutée sans raison.
- Mettez à jour la documentation et `CHANGELOG.md` (`[Unreleased]`) avec le code. Voir aussi [CONTRIBUTING.md](CONTRIBUTING.md).
