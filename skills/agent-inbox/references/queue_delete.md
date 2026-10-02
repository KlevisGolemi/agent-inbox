# queue_delete

Supprime définitivement un message par son `id` (UUID, pas le `correlation_id`). Irréversible : les fichiers joints sont effacés.

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `id` | uuid | — | Identifiant (UUID) du message. |

## Exemples

- `queue_delete({ id: "<uuid>" })` → message supprimé.

## Réponse

`{ ok, deleted: id }`.

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| `not_found` | Identifiant inconnu. | Vérifier l'`id`. |
