# queue_send

Ajoute un message dans la file (ex. une réponse ou une tâche pour n8n). Renvoie `{ ok, id, correlation_id, pending, topic }`. `correlation_id` (optionnel) doit être unique : un doublon renvoie `duplicate_correlation_id`.

Fichiers : `attachments: [{filename, data_base64}]` pour de petits fichiers (total décodé limité par `mcp_upload_max_mb`, 5 Mo par défaut ; `0` désactive cette voie) ; pour un gros fichier, appeler `inbox_upload_link` puis `curl`.

Tags : `tags` n'accepte que des tags EXISTANTS (un tag inconnu est refusé, avec les tags proches dans `similar`) ; routine : réutiliser un tag existant, sinon `new_tags: [{name, description}]`. Rien n'est écrit si une validation échoue.

## Paramètres

| Nom              | Type                     | Défaut                                      | Rôle                                                                 |
| ---------------- | ------------------------ | ------------------------------------------- | -------------------------------------------------------------------- |
| `payload`        | objet JSON               | —                                           | Contenu JSON du message.                                             |
| `correlation_id` | `^[A-Za-z0-9_-]{1,128}$` | —                                           | Identifiant unique pour retrouver le message.                        |
| `source`         | string 1–100             | `claude`                                    | Origine du message.                                                  |
| `topic`          | `^[A-Za-z0-9_-]{1,128}$` | `default`                                   | Canal.                                                               |
| `attachments`    | tableau ≤ 50             | —                                           | Fichiers joints en base64 `[{filename, mime_type?, data_base64}]`.   |
| `tags`           | tableau ≤ 20 de strings  | —                                           | Tags existants du registre (voir `inbox_tags`).                      |
| `new_tags`       | tableau ≤ 20             | —                                           | Tags à créer puis poser `[{name, description}]`.                     |
| `force_new_tags` | booléen                  | `false`                                     | Créer `new_tags` même si un tag proche existe.                       |
| `on_download`    | `keep` \| `consume`      | réglage `file_on_download_default` (`keep`) | `consume` : fichier effacé peu après sa première livraison complète. |

## Exemples

- `queue_send({ payload: { text: "Bonjour" } })`.
- Tag existant (`ci`) et tag nouveau (`deploiement`) : `queue_send({ payload: { cmd: "build" }, tags: ["ci"], new_tags: [{ name: "deploiement", description: "Messages liés aux déploiements" }] })`.
- Gros fichier : utiliser `inbox_upload_link` à la place.

## Réponse

`{ ok, id, correlation_id, pending, topic, tags?, attachments? }` : `tags` liste les noms posés (existants et créés) ; `attachments` : `[{ id, filename, mime_type, category, size_bytes }]`.

## Erreurs

Un échec renvoie `{ ok: false, error, ... }` (`message`, et `hint`, `unknown` ou `similar` pour les tags).

| Code                       | Sens                                                                                                         | Que faire                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `duplicate_correlation_id` | `correlation_id` déjà utilisé (`existing_id` dans la réponse).                                               | Choisir un autre identifiant.                                        |
| `unknown_tags`             | Tag(s) inconnu(s) : `unknown` et `similar` indiquent les proches.                                            | Réutiliser un tag proche, ou `new_tags`.                             |
| `similar_exists`           | Un `new_tags` ressemble à un tag existant : le détail est dans `similar` (par nom demandé).                  | Réutiliser le tag proche, ou `force_new_tags: true`.                 |
| `invalid_name`             | Nom de tag invalide une fois normalisé : doit respecter `^[a-z0-9][a-z0-9-]{0,47}$` (48 caractères au plus). | Corriger le nom.                                                     |
| `invalid_description`      | Description de `new_tags` hors de 10–280 caractères.                                                         | Corriger la description.                                             |
| `too_many_tags`            | Plus de 20 tags (`tags` + `new_tags`).                                                                       | En poser moins.                                                      |
| `mcp_upload_disabled`      | Envoi en base64 désactivé (`mcp_upload_max_mb` à 0).                                                         | Utiliser `inbox_upload_link`.                                        |
| `invalid_base64`           | Une pièce n'est pas du base64 valide.                                                                        | Réencoder le fichier.                                                |
| `attachments_too_large`    | Total décodé supérieur à `mcp_upload_max_mb`.                                                                | Utiliser `inbox_upload_link`.                                        |
| `too_many_files`           | Plus de fichiers que `attachments_max_per_message` (10 par défaut).                                          | Envoyer en plusieurs messages.                                       |
| `empty_file`               | Une pièce est vide.                                                                                          | Retirer la pièce.                                                    |
| `file_too_large`           | Fichier au-dessus du plafond de sa catégorie (`file_max_mb`).                                                | Utiliser `inbox_upload_link` si le plafond le permet, sinon réduire. |
| `category_not_allowed`     | Catégorie hors `file_allowed_categories`.                                                                    | Changer de fichier.                                                  |
| `extension_blocked`        | Extension dans `file_blocked_extensions`.                                                                    | Changer de fichier.                                                  |
| `quota_exceeded`           | Quota de stockage atteint.                                                                                   | Faire de la place (`queue_delete`) ou prévenir l'administrateur.     |
| `disk_full`                | Disque du serveur insuffisant.                                                                               | Prévenir l'administrateur.                                           |
| `attachments_disabled`     | Pièces jointes désactivées sur le serveur.                                                                   | Prévenir l'administrateur.                                           |
| `shutting_down`            | Le serveur s'arrête.                                                                                         | Réessayer dans un instant.                                           |
| `aborted`                  | Envoi interrompu.                                                                                            | Réessayer.                                                           |
| (validation du schéma)     | Paramètres invalides : rejet par la validation du schéma, avant exécution.                                   | Respecter les types et bornes du tableau ci-dessus.                  |
