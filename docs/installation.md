# Installation

## Prérequis

- Un serveur Linux (x86-64 ou arm64) avec **Docker** et **Docker Compose v2**, plus `openssl` et `curl`.
- Les ports **80 et 443** ouverts vers le serveur (certificats Let's Encrypt, HTTPS).
- Un nom de domaine dont l'enregistrement DNS pointe vers le serveur, **ou** l'adresse IP publique du serveur
  (voir [Sans domaine](#sans-nom-de-domaine-sslipio)).

**HTTPS est obligatoire** : Claude et ChatGPT n'acceptent pas de connecteur MCP en HTTP, et l'application
refuse de démarrer avec une `PUBLIC_URL` en `http://` hors `NODE_ENV=development`.

## Avec un nom de domaine (Caddy)

Créez l'enregistrement DNS (`A` ou `AAAA`) de `queue.example.com` vers le serveur, puis :

```bash
git clone https://github.com/KlevisGolemi/agent-inbox.git
cd agent-inbox
./install.sh
```

Le script pose quelques questions (domaine, compte administrateur, mise à jour en un clic), écrit `.env`,
démarre l'application et Caddy, puis attend que `/healthz` réponde. Caddy obtient et renouvelle le
certificat tout seul. Seul Caddy publie des ports ; l'application n'est jamais exposée directement.

Sans interaction (CI, agent) :

```bash
CQ_YES=1 CQ_PUBLIC_URL=https://queue.example.com ./install.sh
```

Toutes les variables `CQ_*` sont listées dans l'en-tête de [`install.sh`](../install.sh) et dans
[AGENTS.md](../AGENTS.md#2-installer). Le script refuse d'écraser un `.env` existant sauf avec `--force`.

Une fois installé :

| Adresse | Usage |
|---|---|
| `https://queue.example.com/admin` | Interface d'administration |
| `https://queue.example.com/mcp` | Adresse MCP à donner à Claude et ChatGPT |
| `https://queue.example.com/webhook` | Dépôt des événements par n8n et les scripts |
| `https://queue.example.com/healthz` | Santé, sans authentification |

**Premier compte administrateur.** Si vous n'en avez pas créé pendant l'installation, ouvrez `/setup` et
saisissez le code de setup affiché dans les logs :

```bash
docker compose logs app | grep -i setup
```

Autre option, sans passer par le navigateur (le mot de passe ne reste pas dans `.env`) :

```bash
printf '%s\n' "$MOT_DE_PASSE" | docker compose exec -T app node dist/cli.js create-admin vous@example.com
```

## Sans nom de domaine (sslip.io)

Let's Encrypt ne délivre pas de certificat pour une adresse IP. Donnez votre IP à `install.sh` : il la
convertit en `<ip-avec-tirets>.sslip.io` (par exemple `203-0-113-10.sslip.io` pour `203.0.113.10`), un nom
public qui résout vers cette IP. Caddy obtient alors un vrai certificat, et Claude comme ChatGPT acceptent l'URL.

```bash
CQ_YES=1 CQ_PUBLIC_URL=203.0.113.10 ./install.sh
```

## Avec un Traefik existant

Si un Traefik tourne déjà sur le serveur (il occupe donc les ports 80 et 443), n'installez pas Caddy :

```bash
CQ_YES=1 CQ_MODE=traefik CQ_PUBLIC_URL=https://queue.example.com ./install.sh
```

Le script écrit `COMPOSE_FILE=deploy/docker-compose.traefik.yml` dans `.env`. Prérequis côté Traefik : un
entrypoint nommé `websecure` et un certresolver (`letsencrypt` par défaut, réglable avec `CQ_TRAEFIK_CERTRESOLVER`).

**Comment Traefik joint l'application.**

| Votre Traefik | Réglage |
|---|---|
| En `network_mode: host`, sans réseau Docker partagé | Rien à faire : Traefik joint le conteneur par le réseau du projet. |
| Dans un réseau Docker nommé (ex. `traefik_proxy`) | `CQ_TRAEFIK_NETWORK=traefik_proxy`. Le script ajoute `deploy/docker-compose.traefik-network.yml` à `COMPOSE_FILE` et vérifie que le réseau existe. |

**Plusieurs hôtes.** `CQ_TRAEFIK_HOSTS=queue.example.com,mcp.example.com` produit
`TRAEFIK_RULE='Host(`queue.example.com`) || Host(`mcp.example.com`)'` dans `.env`. `PUBLIC_URL` reste
l'adresse canonique (métadonnées OAuth, URLs affichées dans l'interface).

**Derrière Cloudflare (proxy orange).** Cloudflare puis Traefik font deux proxys devant l'application :
`CQ_BEHIND_CLOUDFLARE=1` règle `TRUST_PROXY=2`. Sans cela, l'adresse IP vue par l'application est celle de
Cloudflare et la limite de débit s'applique à tous les clients en même temps.

**Taille des envois derrière Cloudflare.** Cloudflare refuse tout corps de requête au-delà de **100 Mo**
(offres Free et Pro) ou **200 Mo** (Business), avant même d'atteindre le serveur. C'est pourquoi les plafonds
par défaut `file_max_mb` de `video` et `archive` sont de **95 Mo**. Ne les montez au-delà que si l'hôte n'est
**pas** derrière le proxy Cloudflare (DNS seul, nuage gris) ou s'il est en offre Business (jusqu'à 195 Mo
environ). Une installation existante garde ses réglages : vérifiez-les dans Admin → Réglages.

### Ne publiez jamais le port de l'application

La limite de débit (`/webhook`, `/login`, `/token`…) lit l'adresse du client dans `X-Forwarded-For` en ne
faisant confiance qu'à **exactement `TRUST_PROXY` proxys** (1 par défaut, 0 à 5). Si le port 3000 est joignable
directement, n'importe qui peut forger l'en-tête et contourner la limite. N'ajoutez donc pas de `ports:` au
service `app`.

**Port interne.** L'application écoute sur `PORT` (3000 par défaut). Les healthchecks (`Dockerfile`,
`docker-compose.yml`, `deploy/docker-compose.traefik.yml`), `deploy/Caddyfile` et le label Traefik
`loadbalancer.server.port` supposent 3000 : gardez cette valeur, ou adaptez tous ces fichiers en même temps.

Avec Caddy (installation par défaut), l'en-tête `X-Forwarded-For` est écrasé par l'adresse réelle du client ;
derrière un proxy Cloudflare, tous les clients apparaîtraient avec l'IP de Cloudflare : désactivez le proxy
orange (DNS seul) ou utilisez la variante Traefik.

## Mise à jour

```bash
./update.sh
```

Le script fait `git pull --ff-only` si le dossier est un clone, `docker compose pull`, redémarre les
conteneurs, puis attend `/healthz`. Les migrations de base s'appliquent au démarrage.

L'interface signale qu'une release plus récente existe sur GitHub (vérification toutes les
6 heures ; désactivable avec le réglage `update_check_enabled`). Le dépôt surveillé se change avec `UPDATE_REPO`.

### Mise à jour en un clic (optionnelle)

Le profil Compose `updater` ajoute un petit service qui exécute `docker compose pull app` puis
`docker compose up -d app` quand l'interface le demande. Pour l'activer, répondez « oui » à la question de
`install.sh` (`CQ_UPDATER=yes`) ou ajoutez à `.env` :

```bash
COMPOSE_PROFILES=updater
UPDATER_URL=http://updater:8081
UPDATER_SECRET=<openssl rand -hex 32>
```

- **Risque** : le service monte `/var/run/docker.sock` et le dossier du projet. Un accès au socket Docker
  équivaut à un accès root sur l'hôte. Il n'est joignable que depuis le réseau Compose et exige le secret,
  mais n'activez cette option que si vous acceptez ce risque (voir [SECURITY.md](../SECURITY.md)).
- `UPDATER_URL` est une **URL racine** (`http://updater:8081`, sans chemin) : l'application y ajoute
  `/update` elle-même. `UPDATER_URL` et `UPDATER_SECRET` vont ensemble ; le secret fait 32 caractères au minimum.
- Une mise à jour qui dure plus de 10 minutes est interrompue (processus `docker` arrêté, erreur dans les
  logs du service `updater`) ; le bouton redevient alors utilisable.
- Le bouton ne fait pas de `git pull` : il récupère l'image. Pour mettre aussi à jour les fichiers
  (Compose, scripts), lancez `./update.sh`.

## Sauvegarde et restauration

**Depuis l'interface** (Admin → Sauvegardes) : sauvegardes planifiées (toutes les 24 h par défaut, 7
conservées ; réglages `backup_interval_hours` et `backup_retention`, `0` désactive la planification),
sauvegarde manuelle, téléchargement et restauration à chaud. Les fichiers sont des bases SQLite
(`queue-AAAAMMJJ-HHMMSS.db`) dans `/data/backups`. Une restauration crée d'abord une sauvegarde de
sécurité et refuse une sauvegarde d'une autre version du schéma.

**Volume complet** (à faire avant une migration ou une désinstallation) :

```bash
# Sauvegarde
docker run --rm -v agent-inbox-data:/data:ro -v "$PWD":/b alpine tar czf /b/agent-inbox-backup.tgz -C /data .

# Restauration dans un volume vide (application arrêtée : docker compose down)
docker run --rm -v agent-inbox-data:/data -v "$PWD":/b alpine tar xzf /b/agent-inbox-backup.tgz -C /data
docker run --rm -v agent-inbox-data:/data alpine chown -R 1000:1000 /data
```

Le volume s'appelle `agent-inbox-data`, ou la valeur de `QUEUE_VOLUME_NAME` (`docker volume ls`).
Les sauvegardes de l'interface contiennent comptes, clés API (condensés) et secret du webhook : protégez-les.

## Fichiers et journaux du proxy

Le volume `/data` contient la base, `backups/` et `files/` : les pièces jointes et les fichiers reçus
par les liens de dépôt. Le dossier `files/` n'est **pas** inclus dans les sauvegardes de l'interface
(seule la base l'est) ; prévoyez-le dans l'espace disque du volume et dans votre sauvegarde du
volume complet. Deux réglages (Admin → Réglages) le bornent : `storage_quota_gb` (5 par défaut) et
`storage_min_free_gb` (espace disque libre à préserver, 2 par défaut).

**Durée de vie effective.** Un message avec une pièce jointe vivante n'est pas supprimé par le nettoyage
automatique tant qu'une de ses pièces n'est pas expirée. La durée de vie effective est donc
`max(TTL du topic, rétention de ses pièces)`. Les liens de dépôt expirés ou révoqués depuis plus de
30 jours sont purgés avec leur journal (`drop_events`) ; les messages déjà reçus restent.

**Secret de signature régénéré après restauration.** Après toute restauration d'une sauvegarde, le réglage
`file_signing_secret` est recréé : les anciens liens signés (`/files/<id>?exp=…&sig=…`) ne fonctionnent
plus. Les fichiers sans ligne en base sont effacés au nettoyage suivant.

**Mise à jour 2.1 → 2.2 (migration v4).** Les sauvegardes de la v3 ne sont pas compatibles avec le
schéma v4. Après la montée de version, faites immédiatement une sauvegarde fraîche avant de compter
sur la restauration à chaud.

**Attention au journal d'accès de votre reverse proxy.** Il enregistre les URL complètes, donc les
jetons des liens de dépôt (`/d/<jeton>`) et les signatures des liens de fichier
(`/files/<id>?exp=…&sig=…`) : quiconque lit ces journaux peut déposer des fichiers ou télécharger
une pièce jointe encore valide. L'application elle-même ne les journalise jamais. Le `Caddyfile`
fourni n'active aucun journal d'accès. Si vous en activez un, masquez ces chemins.

L'en-tête `Connection` est hop-by-hop : il ne vaut que pour un saut de connexion. La fermeture après une
erreur d'envoi (lingering) de l'application ne concerne donc que la connexion proxy → application. Caddy ou
Traefik décident eux-mêmes, indépendamment, de garder ou de fermer leur propre connexion avec le client ;
ils lui relaient seulement la réponse d'erreur.

Caddy (bloc `log` ajouté au site) :

```caddyfile
log {
	format filter {
		request>uri regexp ^/(d|files)/.* /$1/[masqué]
	}
}
```

Traefik (journal d'accès activé, drapeaux de la configuration statique). Le format par défaut,
`common`, écrit le chemin dans chaque ligne et **ne permet pas** de masquer des champs : il faut passer
au format JSON, puis supprimer les champs qui contiennent le chemin.

```text
--accesslog.format=json
--accesslog.fields.names.RequestPath=drop
--accesslog.fields.names.RequestLine=drop
--accesslog.fields.queryparameters.defaultmode=drop
```

`RequestPath` est l'URI de la requête et `RequestLine` (méthode, chemin et protocole) la contient aussi :
supprimez les deux, ainsi que les paramètres de requête (signatures `?sig=`). Gardez `RequestHost` et
`DownstreamStatus`. Les en-têtes ne sont pas journalisés par défaut : si vous passez
`--accesslog.fields.headers.defaultmode=keep`, ajoutez `--accesslog.fields.headers.names.Referer=drop`.
Les mêmes réglages en YAML (configuration statique) :

```yaml
accessLog:
  format: json
  fields:
    names:
      RequestPath: drop
      RequestLine: drop
    queryParameters:
      defaultMode: drop
    headers:
      defaultMode: keep   # seulement si vous journalisez des en-têtes
      names:
        Referer: drop
```

## Migration depuis la v1

La v2 reprend la base de la v1 telle quelle : messages, `correlation_id` et schéma sont conservés. Les
comptes, clés et réglages sont créés par la v2.

1. **Arrêtez la v1 sans supprimer le volume** : dans l'ancien dossier, `docker compose down` (sans `-v`).
2. **Sauvegardez le volume** avec la commande `tar` ci-dessus (remplacez `agent-inbox-data` par le nom du
   volume de la v1, visible avec `docker volume ls | grep queue` ; par défaut `webhook-queue_queue_data`).
3. **Préparez la v2** : clonez le dépôt, puis `cp .env.example .env` et renseignez :
   - `PUBLIC_URL` et `SITE_HOST` (le domaine de l'ancienne file garde l'adresse de `/webhook` pour n8n) ;
   - `QUEUE_VOLUME_NAME=webhook-queue_queue_data` (le nom exact du volume existant : confirmez-le avec `docker volume ls | grep queue`) ;
   - `WEBHOOK_SECRET` et `TTL_HOURS` repris de l'ancien `.env` : ils sont importés **une seule fois** comme
     valeurs initiales, puis gérés dans l'interface. Un `WEBHOOK_SECRET` de moins de 32 caractères est
     refusé au démarrage : retirez-le, un secret est généré, et mettez à jour n8n.
4. **Donnez le volume à l'utilisateur de l'application** (une seule fois ; le conteneur v2 ne tourne pas en root) :

   ```bash
   docker run --rm -v webhook-queue_queue_data:/data alpine chown -R 1000:1000 /data
   ```

5. **Démarrez** : `docker compose up -d`, puis créez le compte administrateur (`/setup`, voir plus haut).
6. **Reconnectez Claude** : l'ancienne URL `/t/<jeton>/mcp` n'existe plus. Supprimez l'ancien connecteur et
   ajoutez `https://<hôte>/mcp` ([guide](connecter-un-client.md)).

Les workflows n8n qui appellent `/webhook`, `/next` ou `/peek` fonctionnent sans modification.
Autres changements : [CHANGELOG.md](../CHANGELOG.md#200---2026-10-01).

## Migration 2.0 → 2.1

La 2.1 renomme le projet en Agent Inbox (le préfixe « Cowork » est réservé par Claude Desktop).

- `COMPOSE_PROJECT_NAME` passe de `cowork-queue` à `agent-inbox` : Docker Compose crée un nouveau conteneur
  (et un nouveau réseau). Arrêtez l'ancien projet (`docker compose down`, sans `-v`) avant de démarrer le nouveau.
- Gardez `QUEUE_VOLUME_NAME` pointé vers le volume existant (par défaut, l'ancien `cowork-queue-data`) :
  sans cela, une base vide serait créée dans `agent-inbox-data`.
- Les clés API `cwk_…` ne sont plus acceptées : recréez-les (préfixe `aik_`) dans Admin → Connexions.
- Les cookies de session sont renommés : reconnectez-vous à l'administration.
- Image `ghcr.io/klevisgolemi/agent-inbox` ; dans n8n, credential `Agent Inbox` et variable `AGENT_INBOX_URL`.

## Désinstallation

```bash
./uninstall.sh
```

Le script demande confirmation, propose d'archiver le volume (`agent-inbox-backup-<date>.tgz` dans le dossier
courant), supprime conteneurs, volumes et image, puis `.env`. Options : `--yes` (aucune question, sauvegarde
incluse) et `--no-backup`. Opération destructive : la base entière est supprimée.

## Dépannage

| Symptôme | Cause probable et solution |
|---|---|
| Le connecteur apparaît mais n'expose **aucun outil** | L'URL doit se terminer par `/mcp`. Vérifiez : `curl -i -X POST https://<hôte>/mcp` doit répondre **401** avec un en-tête `WWW-Authenticate: Bearer … resource_metadata=…`. Si ce n'est pas le cas, le proxy ne route pas vers l'application ou l'URL est mauvaise. Supprimez puis rajoutez le connecteur. |
| **401** sur `/webhook` ou `/next` | Le header `x-webhook-secret` est absent ou différent du secret courant (Admin → Réglages). Une rotation du secret invalide l'ancien immédiatement. |
| **401** sur `/mcp` avec une clé API | Clé révoquée, mal copiée, ou en-tête qui n'est pas `Authorization: Bearer aik_…`. Créez-en une dans Admin → Connexions. |
| **429** | Limite de débit atteinte (`webhook_rate_limit_per_min`, 100 par défaut ; 10 par minute sur `/login`, `/token`). Si elle frappe tout le monde à la fois, `TRUST_PROXY` ne correspond pas au nombre de proxys. |
| Pas de certificat, navigateur en erreur | Le DNS doit pointer vers le serveur et les ports 80/443 être joignables avant la première visite. Voir `docker compose logs caddy` (ou les logs de Traefik). |
| Code de setup introuvable | `docker compose logs app \| grep -i setup`. Il n'existe que tant qu'aucun compte n'a été créé et change à chaque redémarrage. |
| Mot de passe oublié | `docker compose exec app node dist/cli.js reset-password <email>` (saisie masquée ; ferme toutes les sessions et révoque les jetons OAuth du compte, pas les clés API). |
| L'application ne démarre pas | `docker compose logs app` : une variable invalide produit `Configuration invalide : …` avec le nom de la variable. |
| `/healthz` répond mais `install.sh` signale l'URL publique injoignable | DNS en cours de propagation, ports fermés ou certificat en cours d'émission : réessayez après une minute. |
