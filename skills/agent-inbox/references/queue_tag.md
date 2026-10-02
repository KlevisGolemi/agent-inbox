# queue_tag

Ajoute (`add`) ou retire (`remove`) des tags sur un message (`message_id` UUID, pas `correlation_id`). `add` n'accepte que des tags EXISTANTS ; un tag inconnu est refusé, avec les tags proches dans `similar`. Pour un tag vraiment nouveau, `new_tags: [{name, description}]` le crée et le pose. Rien n'est écrit si une validation échoue.

## Paramètres

| Nom              | Type                    | Défaut  | Rôle                                             |
| ---------------- | ----------------------- | ------- | ------------------------------------------------ |
| `message_id`     | uuid                    | —       | Identifiant (UUID) du message.                   |
| `add`            | tableau ≤ 20 de strings | —       | Tags existants à poser.                          |
| `remove`         | tableau ≤ 20 de strings | —       | Tags à retirer.                                  |
| `new_tags`       | tableau ≤ 20            | —       | Tags à créer puis poser `[{name, description}]`. |
| `force_new_tags` | booléen                 | `false` | Créer `new_tags` même si un tag proche existe.   |

## Exemples

- `queue_tag({ message_id: "<uuid>", add: ["facture"], remove: ["brouillon"] })`.
- `queue_tag({ message_id: "<uuid>", new_tags: [{ name: "urgent", description: "À traiter en priorité" }] })`.

## Réponse

`{ ok, message_id, tags, created? }` : `tags` = tags du registre actuellement posés sur le message ; `created` = noms des tags créés par cet appel.

## Erreurs

| Code                   | Sens                                                                                          | Que faire                                            |
| ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `not_found`            | Message inconnu.                                                                              | Vérifier le `message_id`.                            |
| `unknown_tags`         | Tag(s) de `add` inconnu(s) : `unknown` et `similar` indiquent les proches.                    | Réutiliser un tag proche, ou `new_tags`.             |
| `similar_exists`       | Un `new_tags` ressemble à un tag existant : détail dans `similar`.                            | Réutiliser le tag proche, ou `force_new_tags: true`. |
| `invalid_name`         | Nom de tag invalide une fois normalisé : `^[a-z0-9][a-z0-9-]{0,47}$` (48 caractères au plus). | Corriger le nom.                                     |
| `invalid_description`  | Description de `new_tags` hors de 10–280 caractères.                                          | Corriger la description.                             |
| `too_many_tags`        | Plus de 20 tags dans `add` + `new_tags`.                                                      | En poser moins.                                      |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution.                    | Respecter les types et bornes du tableau ci-dessus.  |
