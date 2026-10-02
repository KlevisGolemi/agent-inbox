# queue_nack

Rend un message emprunté à la file (statut → `pending`) quand tu ne peux pas le traiter : il sera servi à nouveau. À appeler avec le `item.lease_id` reçu.

## Paramètres

| Nom        | Type         | Défaut | Rôle                                            |
| ---------- | ------------ | ------ | ----------------------------------------------- |
| `lease_id` | string 1–100 | —      | Valeur de `item.lease_id` renvoyée à l'emprunt. |

## Exemples

- `queue_nack({ lease_id: "<id>.<tentative>" })` → message rendu à la file.

## Réponse

`{ ok: true }`.

## Erreurs

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `invalid_lease`        | `lease_id` mal formé.                                                      | Reprendre celui reçu à l'emprunt.                   |
| `not_found`            | Message introuvable.                                                       | Peut avoir été supprimé.                            |
| `not_leased`           | Déjà acquitté, rendu ou ré-emprunté.                                       | Relever à nouveau si nécessaire.                    |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
