# queue_next

Emprunte le plus ancien message en attente (ordre d'arrivée) et le renvoie avec son `lease_id` ; renvoie `{ empty: true }` si la file est vide. Effet de bord : le message passe en « leased ».

## Paramètres

| Nom     | Type                     | Défaut | Rôle               |
| ------- | ------------------------ | ------ | ------------------ |
| `topic` | `^[A-Za-z0-9_-]{1,128}$` | —      | Canal à consommer. |

## Exemples

- `queue_next()` → prochain message de tous les topics.
- `queue_next({ topic: "default" })` → prochain message du topic `default`.

## Réponse

`{ ok, empty: false, item: { id, source, correlation_id, topic, created_at, read_at, lease_until, lease_id, attempts, attachments, tags, auto_tags, payload }, pending }` (plus `trust` et `warning` pour un message externe). Le `lease_id` est dans `item.lease_id` (format `<id>.<tentative>`). File vide : `{ ok: true, empty: true, item: null }`.

## Erreurs

Une file vide n'est pas une erreur (`empty: true`).

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
