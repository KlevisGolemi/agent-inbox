# queue_send

Ajoute un message dans la file (ex. une réponse ou une tâche pour n8n). Renvoie `{ id, pending, topic }`. `correlation_id` (optionnel) doit être unique : un doublon renvoie `duplicate_correlation_id`.

Fichiers : `attachments: [{filename, data_base64}]` pour de petits fichiers (total décodé limité par `mcp_upload_max_mb`) ; pour un gros fichier, appeler `inbox_upload_link` puis `curl`.

Tags : `tags` n'accepte que des tags EXISTANTS (un tag inconnu est refusé avec les tags proches) ; routine : réutiliser un tag existant, sinon `new_tags: [{name, description}]`.

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `payload` | objet JSON | — | Contenu JSON du message. |
| `correlation_id` | `^[A-Za-z0-9_-]{1,128}$` | — | Identifiant unique pour retrouver le message. |
| `source` | string 1–100 | `claude` | Origine du message. |
| `topic` | `^[A-Za-z0-9_-]{1,128}$` | `default` | Canal. |
| `attachments` | tableau ≤ 50 | — | Fichiers joints en base64 `[{filename, mime_type?, data_base64}]`. |
| `tags` | tableau de strings | — | Tags existants du registre (voir `inbox_tags`). |
| `new_tags` | tableau ≤ 20 | — | Tags à créer puis poser `[{name, description}]`. |
| `force_new_tags` | booléen | `false` | Créer `new_tags` même si un tag proche existe. |
| `on_download` | `keep` \| `consume` | réglage serveur | `consume` : effacé peu après la première livraison complète. |

## Exemples

- `queue_send({ payload: { text: "Bonjour" } })`.
- `queue_send({ payload: { cmd: "build" }, tags: ["ci"], new_tags: [{ name: "ci", description: "Messages de l'intégration continue" }] })`.
- Gros fichier : utiliser `inbox_upload_link` à la place.

## Réponse

`{ ok, id, correlation_id, pending, topic, tags?, attachments? }`.

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| `duplicate_correlation_id` | `correlation_id` déjà utilisé. | Choisir un autre identifiant. |
| `unknown_tags` | Tag(s) inconnu(s). | Créer le tag avec `inbox_create_tag` ou `new_tags`. |
| `similar_exists` | Tag proche existe. | Réutiliser le tag listé dans `similar`. |
| `invalid_name` / `invalid_description` | Nom ou description de tag invalide. | Respecter 1–60 car. et 10–280 car. |
| `too_many_tags` | Trop de tags. | Maximum 20 par message. |
| `mcp_upload_disabled` | Upload MCP désactivé. | Contacter l'administrateur. |
| `invalid_base64` | Base64 mal encodé. | Réencoder le fichier. |
| `attachments_too_large` | Total décodé > `mcp_upload_max_mb`. | Utiliser `inbox_upload_link`. |
| `file_too_large` | Fichier hors limite de catégorie. | Vérifier `file_max_mb` pour la catégorie. |
| `quota_exceeded` | Quota disque atteint. | Nettoyer ou augmenter le quota. |
| `disk_full` | Disque insuffisant. | Libérer de l'espace. |
| `category_not_allowed` | Catégorie interdite. | Vérifier `file_allowed_categories`. |
| `extension_blocked` | Extension bloquée. | Vérifier `file_blocked_extensions`. |
| `attachments_disabled` | Pièces jointes désactivées globalement. | Contacter l'administrateur. |
