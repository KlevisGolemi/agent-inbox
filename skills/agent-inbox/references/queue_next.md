# queue_next

Emprunte le plus ancien message en attente (ordre d'arrivée) et le renvoie avec son `lease_id` ; renvoie `{ empty: true }` si la file est vide. Effet de bord : le message passe en « leased ».

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `topic` | `^[A-Za-z0-9_-]{1,128}$` | — | Canal à consommer. |

## Exemples

- `queue_next()` → prochain message de tous les topics.
- `queue_next({ topic: "default" })` → prochain message du topic `default`.

## Réponse

`{ ok, empty, item, pending, lease_id }` ou `{ ok, empty: true, item: null }`.

## Erreurs

Aucune ; une file vide renvoie `empty: true`.
