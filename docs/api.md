# API HTTP

L'API des producteurs : ce que n8n, un script ou un `curl` utilisent. Elle est compatible avec la v1.
Les assistants (Claude, ChatGPT) passent plutôt par [MCP](connecter-un-client.md).

## Principes

- **Authentification** : en-tête `x-webhook-secret` (Admin → Réglages). Absent ou faux : `401 {"ok":false,"error":"Unauthorized"}`.
  La rotation du secret est immédiate, sans redémarrage. Sans authentification : `/healthz` et `/status`.
- **Corps** : JSON, 1 Mo (1 048 576 octets) au maximum (`413 payload_too_large` au-delà, `400 invalid_json` si illisible).
- **Réponses** : toujours du JSON avec `ok: true|false`. En cas d'erreur, `error` est un code stable.
- **Identifiants** : `correlation_id` et `topic` suivent le motif `^[A-Za-z0-9_-]{1,128}$`.
- **Limite de débit** : `POST /webhook` seulement, 100 requêtes par minute et par IP par défaut
  (réglage `webhook_rate_limit_per_min`). Dépassement : `429 {"ok":false,"error":"Too many requests"}`.
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

### `POST /webhook`

| En-tête | Obligatoire | Rôle |
|---|---|---|
| `x-webhook-secret` | oui | Secret partagé |
| `x-topic` | non | Canal du message (défaut `default`) |
| `x-correlation-id` | non | Identifiant **unique dans toute la file**, pour retrouver ce message |
| `x-source` | non | Origine (défaut `n8n`, 100 caractères au maximum) |

Le corps JSON est le payload.

```bash
curl -X POST "$QUEUE_URL/webhook" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -H "x-topic: events" -H "x-correlation-id: order-4217" \
  -H "Content-Type: application/json" -d '{"event":"order.created","order_id":4217}'
# {"ok":true,"id":"<uuid>","correlation_id":"order-4217","pending":1,"topic":"events"}
```

| Code | `error` | Cause |
|---|---|---|
| 400 | `invalid_correlation_id`, `invalid_topic` | Valeur hors motif |
| 400 | `invalid_source` | `x-source` de plus de 100 caractères |
| 409 | `duplicate_correlation_id` | Déjà utilisé (même pour un message déjà lu) ; la réponse contient `existing_id` |

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
            "created_at": "…", "read_at": "…", "delete_at": "…", "payload": { "event": "order.created" } } }
```

File vide : `{"ok":true,"empty":true,"item":null}` (avec `wait`, après l'attente). Codes d'erreur : `400 invalid_topic`, `400 invalid_wait`.

### Bail et acquittement

Avec `?ack=manual`, le message passe en `leased` pour `lease_timeout_sec` secondes (300 par défaut, réglable).
La réponse de `/next` contient `id`, `source`, `correlation_id`, `topic`, `created_at`, `read_at` (toujours `null`), `lease_until`, `lease_id`, `attempts` et `payload` ; `delete_at` est absent.

- `POST /ack/:lease_id` : le message devient `read`.
- `POST /nack/:lease_id` : il redevient `pending` et sera servi à nouveau.
- Sans réponse avant `lease_until`, il est servi à nouveau (`attempts` augmente) : un consommateur qui plante ne perd rien.
- `lease_id` a la forme `<uuid>.<attempts>` : un nouvel emprunt invalide l'ancien `lease_id`. Un bail expiré
  mais pas encore ré-emprunté reste acquittable.

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
| `limit` | 50 | 1 à 500 (valeur corrigée, pas d'erreur) |
| `offset` | 0 | ≥ 0 |
| `topic` | tous | motif d'identifiant |

```json
{ "ok": true, "limit": 50, "offset": 0,
  "stats": { "total": 3, "pending": 2, "leased": 0, "read_count": 1, "topics": { "events": 3 } },
  "items": [ { "id": "…", "source": "n8n", "correlation_id": null, "topic": "events", "status": "pending",
               "created_at": "…", "read_at": null, "lease_until": null, "lease_id": null,
               "attempts": 0, "payload": {} } ] }
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
| `limit` | 1 à 100 (50 par défaut) |

Un paramètre invalide donne `400 invalid_<paramètre>` (ex. `invalid_status`).

### `GET /stats`

```json
{ "ok": true, "uptime_s": 86400, "ttl_hours": 48, "cleanup_interval_min": 60,
  "stats": { "total": 3, "pending": 2, "leased": 0, "read_count": 1, "topics": { "events": 3 } } }
```

`?topic=` limite les compteurs à un topic.

### Suppression

- `DELETE /message/:id` : `id` est l'UUID renvoyé par `/webhook` (pas le `correlation_id`). `{"ok":true,"deleted":"<id>"}`, ou `404`.
- `DELETE /clear` : supprime tous les messages de tous les topics. `{"ok":true}`.

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

## n8n : nœud HTTP Request

1. Créez un credential **Header Auth** : *Name* `x-webhook-secret`, *Value* le secret ; nommez-le `Cowork Queue`.
2. Nœud **HTTP Request** (v4) : *Method* `POST`, *URL* `https://queue.example.com/webhook`, *Authentication*
   `Generic Credential Type` → `Header Auth` → `Cowork Queue`.
3. *Send Headers* : `x-topic` (et `x-correlation-id` si besoin). *Send Body* : JSON.

Des workflows prêts à importer sont dans [`examples/n8n/`](../examples/n8n/README.md).

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
