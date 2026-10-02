# queue_ack

Confirme qu'un message emprunté a été traité (statut → `read`). À appeler avec le `item.lease_id` reçu de `queue_next`, `queue_wait` ou `queue_by_id`.

## Paramètres

| Nom        | Type         | Défaut | Rôle                                            |
| ---------- | ------------ | ------ | ----------------------------------------------- |
| `lease_id` | string 1–100 | —      | Valeur de `item.lease_id` renvoyée à l'emprunt. |

## Exemples

- `queue_ack({ lease_id: "<id>.<tentative>" })` → message acquitté.

## Réponse

`{ ok: true }`.

## Erreurs

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `invalid_lease`        | `lease_id` mal formé.                                                      | Reprendre celui reçu à l'emprunt.                   |
| `not_found`            | Message introuvable.                                                       | Peut avoir été supprimé.                            |
| `not_leased`           | Déjà acquitté, rendu ou ré-emprunté.                                       | Relever à nouveau si nécessaire.                    |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
