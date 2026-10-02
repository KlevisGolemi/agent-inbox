# queue_tag

Ajoute (`add`) ou retire (`remove`) des tags sur un message (`message_id` UUID, pas `correlation_id`). `add` n'accepte que des tags EXISTANTS ; un tag inconnu est refusé avec les tags proches. Pour un tag vraiment nouveau, `new_tags: [{name, description}]` le crée et le pose.

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `message_id` | uuid | — | Identifiant (UUID) du message. |
| `add` | tableau de strings | — | Tags existants à poser. |
| `remove` | tableau de strings | — | Tags à retirer. |
| `new_tags` | tableau ≤ 20 | — | Tags à créer puis poser `[{name, description}]`. |
| `force_new_tags` | booléen | `false` | Créer `new_tags` même si un tag proche existe. |

## Exemples

- `queue_tag({ message_id: "<uuid>", add: ["facture"], remove: ["brouillon"] })`.
- `queue_tag({ message_id: "<uuid>", new_tags: [{ name: "urgent", description: "À traiter en priorité" }] })`.

## Réponse

`{ ok, message_id, tags, created? }`.

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| `not_found` | Message inconnu. | Vérifier le `message_id`. |
| `unknown_tags` | Tag(s) à ajouter inconnu(s). | Utiliser `inbox_tags` ou `new_tags`. |
| `similar_exists` | Tag proche existe. | Réutiliser le tag listé dans `similar`. |
