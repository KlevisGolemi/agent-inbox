# queue_peek

Liste les messages du plus récent au plus ancien, avec leur statut (pending, leased, read), SANS les consommer. Renvoie `{ stats, limit, offset, items }`. Lecture seule : à privilégier pour inspecter la file.

## Paramètres

| Nom      | Type                     | Défaut | Rôle                         |
| -------- | ------------------------ | ------ | ---------------------------- |
| `limit`  | entier 1–100             | `50`   | Nombre de messages.          |
| `offset` | entier ≥ 0               | `0`    | Décalage pour la pagination. |
| `topic`  | `^[A-Za-z0-9_-]{1,128}$` | —      | Canal à restreindre.         |

## Exemples

- `queue_peek({ limit: 10 })` → les 10 derniers messages.
- `queue_peek({ topic: "default", offset: 50 })` → page suivante.

## Réponse

`{ ok, stats: { total, pending, leased, read_count, topics }, limit, offset, items }`. Chaque message : `{ id, source, correlation_id, topic, status, created_at, read_at, lease_until, attempts, attachments, tags, auto_tags, payload }` (sans `lease_id` ; plus `trust` et `warning` si externe).

## Erreurs

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
