# inbox_create_tag

Crée un tag dans le registre partagé, avec une description (10 à 280 caractères) qui dit quand l'utiliser. Refusé avec la liste `similar` si un tag proche existe (pluriel, inclusion, faute de frappe) : réutilise-le plutôt. `force: true` crée quand même. Le nom est normalisé (« Facture Client » → `facture-client`).

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `name` | string 1–60 | — | Nom du tag. |
| `description` | string 10–280 | — | Quand utiliser ce tag. |
| `force` | booléen | `false` | Créer même si un tag proche existe. |

## Exemples

- `inbox_create_tag({ name: "Facture Client", description: "Messages contenant une facture à traiter" })` → `facture-client`.
- `inbox_create_tag({ name: "Facture", description: "...", force: true })` → force la création malgré la proximité.

## Réponse

`{ ok, tag: { name, description, ... } }`.

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| `similar_exists` | Tag proche existe. | Réutiliser le tag listé dans `similar` ou forcer. |
| `exists` | Tag déjà existant. | Utiliser ce tag existant. |
| `invalid_name` | Nom invalide. | Respecter 1–60 caractères. |
| `invalid_description` | Description invalide. | Respecter 10–280 caractères. |
