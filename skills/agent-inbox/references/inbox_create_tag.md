# inbox_create_tag

Crée un tag dans le registre partagé, avec une description (10 à 280 caractères) qui dit quand l'utiliser. Refusé avec la liste `similar` si un tag proche existe (pluriel, inclusion, faute de frappe) : réutilise-le plutôt. `force: true` crée quand même. Le nom est normalisé (« Facture Client » → `facture-client`) et doit ensuite respecter `^[a-z0-9][a-z0-9-]{0,47}$` (48 caractères au plus).

## Paramètres

| Nom           | Type          | Défaut  | Rôle                                |
| ------------- | ------------- | ------- | ----------------------------------- |
| `name`        | string 1–60   | —       | Nom du tag (avant normalisation).   |
| `description` | string 10–280 | —       | Quand utiliser ce tag.              |
| `force`       | booléen       | `false` | Créer même si un tag proche existe. |

## Exemples

- `inbox_create_tag({ name: "Facture Client", description: "Messages contenant une facture à traiter" })` → `facture-client`.
- `inbox_create_tag({ name: "Facture", description: "Factures d'un autre type", force: true })` → crée malgré la proximité.

## Réponse

`{ ok, tag }` avec le tag créé (`name`, `description`, `usage_count`, `last_used_at`, etc.).

## Erreurs

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `similar_exists`       | Un tag proche existe : la liste est dans `similar`.                        | Réutiliser un tag listé, ou `force: true`.          |
| `exists`               | Un tag de ce nom existe déjà.                                              | L'utiliser tel quel.                                |
| `invalid_name`         | Nom invalide une fois normalisé : `^[a-z0-9][a-z0-9-]{0,47}$`.             | Corriger le nom.                                    |
| `invalid_description`  | Description hors de 10–280 caractères.                                     | Corriger la description.                            |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
