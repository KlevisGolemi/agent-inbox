# inbox_revoke_drop

Désactive immédiatement un lien de dépôt (`drop_id`) ; les messages déjà reçus restent. Erreur `not_found` si inconnu ou déjà révoqué.

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `drop_id` | uuid | — | Identifiant du lien (`inbox_drops`). |

## Exemples

- `inbox_revoke_drop({ drop_id: "<uuid>" })` → lien révoqué.

## Réponse

`{ ok, drop_id }`.

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| `not_found` | Lien inconnu ou déjà révoqué. | Vérifier le `drop_id`. |
