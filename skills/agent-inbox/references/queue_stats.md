# queue_stats

Compte les messages (total, pending, leased, read_count) et leur répartition par topic. À utiliser pour savoir s'il y a du travail en attente avant `queue_next`. Lecture seule.

## Paramètres

| Nom     | Type                     | Défaut | Rôle                 |
| ------- | ------------------------ | ------ | -------------------- |
| `topic` | `^[A-Za-z0-9_-]{1,128}$` | —      | Canal à restreindre. |

## Exemples

- `queue_stats()` → statistiques globales.
- `queue_stats({ topic: "factures" })` → statistiques du topic `factures`.

## Réponse

`{ ok, ttl_hours, stats: { total, pending, leased, read_count, topics: { "<topic>": nombre } }, storage }`.

## Erreurs

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
