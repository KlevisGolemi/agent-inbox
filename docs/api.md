# API HTTP

L'API des producteurs : ce que n8n, un script ou un `curl` utilisent. Elle est compatible avec la v1.
Les assistants (Claude, ChatGPT) passent plutôt par [MCP](connecter-un-client.md).

## Principes

- **Authentification** : en-tête `x-webhook-secret` (Admin → Réglages). Absent ou faux : `401 {"ok":false,"error":"Unauthorized"}`.
  La rotation du secret est immédiate, sans redémarrage. Sans authentification : `/healthz` et `/status`.
- **Corps** : JSON ou `multipart/form-data`. La limite JSON est `json_max_kb` (1 024 Ko par défaut) ;
  `413 payload_too_large` au-delà, `400 invalid_json` si le JSON est illisible. Les fichiers comptent
  dans leurs propres plafonds par catégorie (`file_max_mb`) et dans le quota global (`storage_quota_gb`).
- **Réponses** : toujours du JSON avec `ok: true|false`. En cas d'erreur, `error` est un code stable.
- **Identifiants** : `correlation_id` et `topic` suivent le motif `^[A-Za-z0-9_-]{1,128}$`.
- **Limites de débit** : `POST /webhook`, 100 requêtes par minute et par IP par défaut (réglage
  `webhook_rate_limit_per_min`) ; `GET /next`, 600 requêtes par minute et par IP. Dépassement :
  `429 {"ok":false,"error":"Too many requests"}`. (`POST /mcp` est limité de même à 600 requêtes par minute.)
- **Erreur interne** : `500 {"ok":false,"error":"internal_error","message":"Erreur interne."}`, sans détail.
- **Cycle de vie d'un message** : `pending` → `read` (consommation directe), ou `pending` → `leased` → `read`
  avec un bail ([ci-dessous](#bail-et-acquittement)). Un message est supprimé après `ttl_hours` (48 h par
  défaut) : à partir de sa lecture s'il est `read`, de sa création sinon. Les messages sont servis dans l'ordre d'arrivée.

## Routes

| Méthode | Route | Rôle |
|---|---|---|
| `POST` | `/webhook` | Dépose un message |
| `GET` | `/next` | Prend le plus ancien message en attente (`topic`, `ack`, `wait`) |
| `GET` | `/by-id/:correlation_id` | Prend ou consulte (`?peek=true`) un message précis |
| `POST` | `/ack/:lease_id` | Confirme le traitement d'un message emprunté |
| `POST` | `/nack/:lease_id` | Remet un message emprunté en file |
| `GET` | `/peek` | Liste paginée, sans consommer |
| `GET` | `/search` | Recherche filtrée, sans consommer |
| `GET` | `/stats` | Compteurs et réglages de rétention |
| `DELETE` | `/message/:id` | Supprime un message (UUID interne) |
| `DELETE` | `/clear` | Vide toute la file |
| `GET` | `/status` | Santé minimale (`uptime_s`), publique |
| `GET` | `/healthz` | Santé et version, publique |
| `GET` | `/files/:id` | Télécharge une pièce jointe (secret ou lien signé `?exp=&sig=`) |
| `GET` | `/d/:token` | Page publique d'un lien de dépôt |
| `POST` | `/d/:token` | Dépose un fichier sur un lien de dépôt |

### `POST /webhook`

| En-tête | Obligatoire | Rôle |
|---|---|---|
| `x-webhook-secret` | oui | Secret partagé |
| `x-topic` | non | Canal du message (défaut `default`) |
| `x-correlation-id` | non | Identifiant **unique dans toute la file**, pour retrouver ce message |
| `x-source` | non | Origine (défaut `n8n`, 100 caractères au maximum) |
| `x-tags` | non | Tags à poser, séparés par des virgules ; les tags inconnus sont créés automatiquement |
| `x-on-download` | non | `keep` (défaut) ou `consume` : efface la pièce peu après sa première livraison |

**Corps JSON.** Le corps est le payload.

```bash
curl -X POST "$QUEUE_URL/webhook" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -H "x-topic: events" -H "x-correlation-id: order-4217" \
  -H "Content-Type: application/json" -d '{"event":"order.created","order_id":4217}'
# {"ok":true,"id":"<uuid>","correlation_id":"order-4217","pending":1,"topic":"events"}
```

**Corps multipart (`multipart/form-data`).** Champ `payload` (JSON texte, optionnel) et un ou plusieurs
fichiers. Le serveur détecte le vrai type par signature binaire, classe le fichier et applique les limites
par catégorie. Les tags inconnus dans `x-tags` sont créés automatiquement.

```bash
curl -X POST "$QUEUE_URL/webhook" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -H "x-topic: compta" -H "x-tags: facture" \
  -F "payload={\"source\":\"n8n\",\"note\":\"Facture du mois\"}" \
  -F "file=@facture.pdf"
# {"ok":true,"id":"<uuid>","correlation_id":null,"pending":1,"topic":"compta","tags":["facture"],"attachments":[{"id":"...","filename":"facture.pdf","mime_type":"application/pdf","category":"document","size_bytes":...}]}
```

| Code | `error` | Cause |
|---|---|---|
| 400 | `invalid_correlation_id`, `invalid_topic` | Valeur hors motif |
| 400 | `invalid_source` | `x-source` de plus de 100 caractères |
| 400 | `too_many_tags` | Plus de 20 tags dans `x-tags` |
| 400 | `invalid_tags` | Tag dont le nom normalisé est hors de `^[a-z0-9][a-z0-9-]{0,47}$` |
| 400 | `invalid_on_download` | Valeur autre que `keep` ou `consume` |
| 400 | `invalid_json` | Champ `payload` multipart illisible |
| 400 | `invalid_multipart` | Corps multipart invalide |
| 400 | `empty_file`, `no_file` | Fichier vide ou aucun fichier reçu |
| 403 | `attachments_disabled` | Pièces jointes désactivées |
| 409 | `duplicate_correlation_id` | Déjà utilisé (même pour un message déjà lu) ; la réponse contient `existing_id` |
| 413 | `payload_too_large` | JSON au-delà de `json_max_kb` |
| 413 | `field_too_large` | Champ `payload` multipart au-delà de `json_max_kb` |
| 413 | `file_too_large` | Fichier au-delà du plafond de sa catégorie |
| 413 | `too_many_files` | Plus de fichiers que `attachments_max_per_message` |
| 415 | `category_not_allowed` | Catégorie refusée par `file_allowed_categories` |
| 415 | `extension_blocked` | Extension dans `file_blocked_extensions` |
| 507 | `quota_exceeded` | Quota `storage_quota_gb` atteint |
| 507 | `disk_full` | Disque insuffisant compte tenu de `storage_min_free_gb` |

Pour les envois multipart, les requêtes interrompues ou refusées en cours d'envoi, l'en-tête `Connection`
et les journaux d'accès du proxy : [Fichiers et journaux du proxy](installation.md#fichiers-et-journaux-du-proxy).

### `GET /next`

Prend le plus ancien message en attente, tous topics confondus ou limité à `?topic=`.

| Paramètre | Valeur | Effet |
|---|---|---|
| `topic` | motif d'identifiant | Ne considère que ce topic |
| `ack` | `manual` | Emprunte le message (bail) au lieu de le marquer lu |
| `wait` | 1 à 50 | Si la file est vide, attend jusqu'à `wait` secondes qu'un message arrive |

Sans `ack=manual`, le message est **marqué lu immédiatement** (comportement de la v1) et la réponse contient
`delete_at` :

```json
{ "ok": true, "empty": false, "pending": 0,
  "item": { "id": "…", "source": "n8n", "correlation_id": "order-4217", "topic": "events",
            "created_at": "…", "read_at": "…", "delete_at": "…",
            "attachments": [], "tags": [], "auto_tags": ["source:n8n", "topic:events"],
            "payload": { "event": "order.created" } } }
```

File vide : `{"ok":true,"empty":true,"item":null}` (avec `wait`, après l'attente, ou aussitôt quand le
serveur s'arrête). Codes d'erreur : `400 invalid_topic`, `400 invalid_wait`, et
`429 too_many_waiters` quand 100 attentes (`wait` ou `queue_wait`) sont déjà en cours : réessayez un peu plus tard.

### Bail et acquittement

Avec `?ack=manual`, le message passe en `leased` pour `lease_timeout_sec` secondes (300 par défaut, réglable).
La réponse de `/next` contient `id`, `source`, `correlation_id`, `topic`, `created_at`, `read_at` (toujours `null`),
`lease_until`, `lease_id`, `attempts`, `attachments`, `tags`, `auto_tags` et `payload` ; `delete_at` est absent.
Si le message vient d'un lien de dépôt public, il porte aussi `trust: "external_unverified"` et un `warning`.

- `POST /ack/:lease_id` : le message devient `read`.
- `POST /nack/:lease_id` : il redevient `pending` et sera servi à nouveau.
- Sans réponse avant `lease_until`, il est servi à nouveau (`attempts` augmente) : un consommateur qui plante ne perd rien.
- `lease_id` a la forme `<uuid>.<attempts>` : un nouvel emprunt invalide l'ancien `lease_id`. Un bail expiré
  mais pas encore ré-emprunté reste acquittable.
- `lease_id` n'apparaît que dans la réponse d'emprunt (`/next`, `/by-id` avec `ack=manual`) ; `/peek`,
  `/search` et `/by-id?peek=true` montrent le statut `leased` et `lease_until`, sans `lease_id`.

| Code | `error` | Cause |
|---|---|---|
| 400 | `invalid_lease` | `lease_id` mal formé |
| 404 | `not_found` | Message inconnu (supprimé ou expiré) |
| 409 | `not_leased` | Déjà acquitté, rendu, ou ré-emprunté avec un `lease_id` plus récent |

```bash
curl -s -H "x-webhook-secret: $WEBHOOK_SECRET" "$QUEUE_URL/next?topic=requests&ack=manual&wait=30"
curl -s -X POST -H "x-webhook-secret: $WEBHOOK_SECRET" "$QUEUE_URL/ack/<lease_id>"
```

### `GET /by-id/:correlation_id`

| Variante | Effet |
|---|---|
| (par défaut) | **Consomme** le message (marqué lu) ; `?ack=manual` l'emprunte |
| `?peek=true` (ou `1`) | Consulte sans rien changer ; la réponse contient `"peek": true` et l'état du message |

| Code | `error` | Cause |
|---|---|---|
| 400 | `invalid_correlation_id` | Hors motif |
| 404 | `not_found` | Aucun message avec cet identifiant |
| 409 | `leased` | Emprunté par un autre consommateur (`lease_until` fourni) |
| 410 | `already_read` | Déjà consommé (`id` et `read_at` fournis) |

C'est la base du motif requête-réponse : voir [cas d'usage](cas-d-usage.md#2-requête-réponse-par-correlation_id).
Attention : côté MCP, `queue_by_id` consulte par défaut ; côté HTTP, `/by-id` consomme par défaut.

### `GET /peek`

Liste du plus récent au plus ancien, sans consommer.

| Paramètre | Défaut | Bornes |
|---|---|---|
| `limit` | 50 | 1 à 500 (valeur corrigée, pas d'erreur ; l'outil MCP `queue_peek` est limité à 100) |
| `offset` | 0 | ≥ 0 |
| `topic` | tous | motif d'identifiant |

```json
{ "ok": true, "limit": 50, "offset": 0,
  "stats": { "total": 3, "pending": 2, "leased": 0, "read_count": 1, "topics": { "events": 3 } },
  "items": [ { "id": "…", "source": "n8n", "correlation_id": null, "topic": "events", "status": "pending",
               "created_at": "…", "read_at": null, "lease_until": null, "attempts": 0,
               "attachments": [], "tags": [], "auto_tags": ["source:n8n", "topic:events"],
               "payload": {} } ] }
```

Pour paginer, avancez `offset` de `limit` tant que `offset + limit < stats.total`.

### `GET /search`

Filtres cumulatifs, résultat du plus récent au plus ancien, sans consommer. `{ "ok": true, "items": [...] }`.

| Paramètre | Valeur |
|---|---|
| `topic` | motif d'identifiant |
| `source` | valeur exacte (ex. `n8n`, `claude`) |
| `status` | `pending`, `leased` ou `read` |
| `since`, `until` | date ISO 8601, sur la date de création (bornes incluses) |
| `text` | sous-chaîne recherchée dans le payload |
| `tag` | tag du registre ou tag automatique (`type:…`, `source:…`, `topic:…`, `external`) |
| `has_attachments` | `true` ou `false` |
| `limit` | 1 à 100 (50 par défaut) |

Un paramètre invalide donne `400 invalid_<paramètre>` (ex. `invalid_status`).

### `GET /stats`

```json
{ "ok": true, "uptime_s": 86400, "ttl_hours": 48, "cleanup_interval_min": 60,
  "stats": { "total": 3, "pending": 2, "leased": 0, "read_count": 1, "topics": { "events": 3 } } }
```

`?topic=` limite les compteurs à un topic. La jauge de stockage des fichiers n'est pas dans cette route :
elle est dans les outils MCP `queue_status` et `queue_stats` et dans l'administration.

### Suppression

- `DELETE /message/:id` : `id` est l'UUID renvoyé par `/webhook` (pas le `correlation_id`). `{"ok":true,"deleted":"<id>"}`, ou `404`.
- `DELETE /clear` : supprime tous les messages de tous les topics. `{"ok":true}`.

### `GET /files/:id`

Télécharge une pièce jointe. Deux modes d'accès :

- **API** : en-tête `x-webhook-secret` (même secret que `/webhook`).
- **Lien signé** : `GET /files/:id?exp=<ms>&sig=<hmac>`, généré par `inbox_get_file` côté MCP.
  Le lien expire après `download_link_ttl_min` (60 min par défaut). Tout refus (inconnu, expiré,
  signature fausse, rotation du secret) renvoie `404`, sans indiquer si la ressource a existé.

En-têtes de réponse : `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`.
Pas de `Range` sur une pièce `consume`.

Le décompte des livraisons est **au plus une fois** : `downloads` n'est incrémenté que sur une livraison
complète. Une pièce `consume` est effacée après `consume_grace_min` (10 min par défaut) suivant sa
première livraison complète, ce qui permet une reprise en cas de crash ou de téléchargement interrompu.

| Code | `error` | Cause |
|---|---|---|
| 401 | `Unauthorized` | Secret absent ou faux |
| 404 | `not_found` | Pièce inconnue, lien invalide ou expiré |
| 410 | `expired` / `consumed` / `file_gone` | Rétention écoulée, pièce `consume` déjà livrée, ou fichier absent du disque |

### `GET /d/:token`

Page HTML autonome d'un lien de dépôt public. Sans cookie ni script tiers, avec une CSP stricte.
Un lien invalide, expiré, révoqué ou épuisé affiche la même page neutre « lien indisponible ».

### `POST /d/:token`

Dépose un ou plusieurs fichiers sur un lien de dépôt (public ou self). Corps `multipart/form-data`.
Pour un lien public, le formulaire accepte aussi un champ texte `text` (10 Ko max). Chaque dépôt crée
un message dans la file ; les liens publics produisent des messages `trust: external_unverified`.

```bash
curl -F file=@photo.jpg 'https://queue.example.com/d/<jeton>'
# {"ok":true,"files":1}
```

| Code | `error` | Cause |
|---|---|---|
| 404 | `unavailable` | Lien inconnu, expiré, révoqué, déjà utilisé ou en cours d'utilisation |
| 415 | `multipart_required` | Corps autre que `multipart/form-data` |
| 400 | `invalid_multipart`, `no_file`, `empty_file` | Corps invalide, aucun fichier ou fichier vide |
| 413 | `file_too_large`, `too_many_files`, `drop_full`, `field_too_large` | Limite de taille, nombre, quota du drop ou champ texte trop long |
| 415 | `category_not_allowed`, `extension_blocked` | Catégorie ou extension refusée |
| 403 | `attachments_disabled` | Pièces jointes désactivées |
| 507 | `quota_exceeded`, `disk_full` | Quota ou disque insuffisant |
| 503 | `aborted`, `shutting_down` | Envoi interrompu ou arrêt du serveur |

Le jeton figure dans l'URL : voir [Fichiers et journaux du proxy](installation.md#fichiers-et-journaux-du-proxy)
pour masquer ces chemins dans les journaux d'accès et pour la remarque sur `Connection`.
| 409 | `duplicate_correlation_id` | `correlation_id` déjà utilisé (lien self) |

## Topics

Un topic est un canal : `x-topic` à l'envoi, `?topic=` à la lecture. Sans `?topic=`, `/next`, `/peek` et
`/stats` portent sur tous les topics. Les messages sans `x-topic` vont dans `default`. Le réglage
`topic_ttl_overrides` (Admin → Réglages) donne une durée de rétention propre à certains topics, par exemple
`{"digest": 168}` pour garder une semaine.

## Réglages

Modifiables à chaud dans Admin → Réglages, sans redémarrage.

| Réglage | Défaut | Bornes | Rôle |
|---|---|---|---|
| `ttl_hours` | 48 | 1 – 8760 | Rétention des messages |
| `topic_ttl_overrides` | `{}` | topic → 1 – 8760 | Rétention par topic |
| `cleanup_interval_min` | 60 | 1 – 1440 | Fréquence du nettoyage |
| `webhook_rate_limit_per_min` | 100 | 1 – 10000 | Limite de `POST /webhook` par IP |
| `webhook_secret` | généré | 32 – 256 caractères | Secret de l'API (rotation en un clic) |
| `lease_timeout_sec` | 300 | 10 – 86400 | Durée d'un bail |
| `backup_interval_hours` | 24 | 0 – 168 | Sauvegardes planifiées (`0` = désactivées) |
| `backup_retention` | 7 | 1 – 90 | Sauvegardes conservées |
| `update_check_enabled` | `true` | booléen | Vérification des releases GitHub |
| `json_max_kb` | 1 024 | 16 – 51 200 | Corps JSON de `/webhook` et `payload` multipart |
| `attachments_enabled` | `true` | booléen | Interrupteur global des pièces jointes |
| `attachments_max_per_message` | 10 | 1 – 50 | Fichiers maximum par message ou par requête de drop |
| `file_max_mb` | `{image:20, audio:50, video:200, document:50, archive:500, other:100}` | 1 – 2048 par catégorie | Taille maximum par catégorie |
| `file_allowed_categories` | les 6 | sous-ensemble | Catégories acceptées |
| `file_blocked_extensions` | `[]` | ≤ 50 | Extensions refusées (ex. `exe`, `bat`) |
| `storage_quota_gb` | 5 | 0.1 – 1000 | Quota de stockage des fichiers |
| `storage_min_free_gb` | 2 | 0 – 1000 | Espace libre minimum à préserver |
| `file_retention_hours` | `{image:168, audio:72, video:24, document:72, archive:24, other:72}` | 1 – 8760 par catégorie | Rétention des pièces jointes |
| `file_retention_large_mb` | 50 | 1 – 2048 | Seuil « gros fichier » |
| `file_retention_large_hours` | 24 | 1 – 8760 | Rétention ramenée au-delà du seuil |
| `file_on_download_default` | `keep` | `keep` / `consume` | Comportement par défaut au téléchargement |
| `consume_grace_min` | 10 | 1 – 1440 | Délai avant effacement d'une pièce `consume` après sa première livraison |
| `inline_max_mb` | 5 | 0 – 20 | Seuil de livraison inline (0 = toujours un lien) |
| `mcp_upload_max_mb` | 5 | 0 – 20 | Total des fichiers base64 d'un `queue_send` (taille décodée) |
| `download_link_ttl_min` | 60 | 1 – 1440 | Durée de vie d'un lien signé |
| `tags_injected_count` | 15 | 0 – 50 | Tags injectés dans les descriptions d'outils |
| `drops_enabled` | `true` | booléen | Liens de dépôt publics |
| `drop_default_hours` | 24 | 1 – 720 | Durée par défaut d'un drop |
| `drop_max_hours` | 168 | 1 – 720 | Durée maximum d'un drop |
| `drop_default_max_files` | 10 | 1 – 1000 | Nombre de fichiers par défaut acceptés par un drop |
| `drop_rate_limit_per_min` | 10 | 1 – 600 | Limite par IP sur `/d/*` |
| `file_signing_secret` | généré | ≥ 32 caractères | Secret HMAC des liens de fichier (rotation en un clic) |

## n8n : nœud HTTP Request

1. Créez un credential **Header Auth** : *Name* `x-webhook-secret`, *Value* le secret ; nommez-le `Agent Inbox`.
2. Nœud **HTTP Request** (v4) : *Method* `POST`, *URL* `https://queue.example.com/webhook`, *Authentication*
   `Generic Credential Type` → `Header Auth` → `Agent Inbox`.
3. *Send Headers* : `x-topic`, `x-tags` (et `x-correlation-id` si besoin).
4. *Send Body* : JSON, ou `multipart-form-data` pour envoyer un fichier (champ `file` en
   `formBinaryData`, champ `payload` JSON optionnel).

Des workflows prêts à importer sont dans [`examples/n8n/`](../examples/n8n/README.md), dont un modèle
« envoyer un fichier » en `multipart/form-data`.

## Exemples de consommateur

Ces exemples remplacent l'ancien `poll.sh`. Ils empruntent le message, le traitent, puis l'acquittent.

**Shell** (`curl` et `jq`) :

```bash
while true; do
  res=$(curl -fsS -H "x-webhook-secret: $WEBHOOK_SECRET" "$QUEUE_URL/next?ack=manual&wait=30")
  [ "$(jq -r .empty <<<"$res")" = "true" ] && continue
  jq -c .item.payload <<<"$res"                       # traitement
  curl -fsS -X POST -H "x-webhook-secret: $WEBHOOK_SECRET" \
    "$QUEUE_URL/ack/$(jq -r .item.lease_id <<<"$res")" >/dev/null
done
```

**Node.js** (≥ 18) :

```js
const headers = { 'x-webhook-secret': process.env.WEBHOOK_SECRET }
const base = process.env.QUEUE_URL

for (;;) {
  const res = await fetch(`${base}/next?ack=manual&wait=30`, { headers })
  const { empty, item } = await res.json()
  if (empty) continue
  console.log(item.payload) // traitement
  await fetch(`${base}/ack/${item.lease_id}`, { method: 'POST', headers })
}
```

**Python** (`requests`) :

```python
import os, requests

base = os.environ["QUEUE_URL"]
headers = {"x-webhook-secret": os.environ["WEBHOOK_SECRET"]}

while True:
    data = requests.get(f"{base}/next", params={"ack": "manual", "wait": 30}, headers=headers, timeout=60).json()
    if data["empty"]:
        continue
    print(data["item"]["payload"])  # traitement
    requests.post(f"{base}/ack/{data['item']['lease_id']}", headers=headers, timeout=10)
```

Pour déposer un message depuis Node ou Python, appelez `POST /webhook` avec les en-têtes ci-dessus
(`Content-Type: application/json`).
