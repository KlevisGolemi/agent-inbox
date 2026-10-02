# queue_peek

Liste les messages du plus récent au plus ancien, avec leur statut (pending, leased, read), SANS les consommer. Renvoie `{ stats, limit, offset, items }`. Lecture seule : à privilégier pour inspecter la file.

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `limit` | entier 1–100 | `50` | Nombre de messages. |
| `offset` | entier ≥ 0 | `0` | Décalage pour la pagination. |
| `topic` | `^[A-Za-z0-9_-]{1,128}$` | — | Canal à restreindre. |

## Exemples

- `queue_peek({ limit: 10 })` → les 10 derniers messages.
- `queue_peek({ topic: "default", offset: 50 })` → page suivante.

## Réponse

`{ ok, stats, limit, offset, items: [message] }`.

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| (validation zod) | `limit`, `offset` ou `topic` invalide. | Respecter les bornes et le format. |
