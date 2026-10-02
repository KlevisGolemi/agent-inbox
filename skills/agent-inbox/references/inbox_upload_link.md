# inbox_upload_link

Crée un lien d'upload à usage unique (15 min) pour déposer un ou plusieurs fichiers depuis un shell, jusqu'au plafond `file_max_mb` de leur catégorie (95 Mo par défaut pour vidéo et archive, voir `max_file_mb` dans la réponse) : exécute ensuite la commande `curl` renvoyée (`curl -F file=@chemin <url>`, un `-F` par fichier). Le message créé porte `topic`, `tags`, `correlation_id` et `payload` donnés ici ; confiance interne. À préférer à `queue_send.attachments` dès qu'un fichier dépasse quelques Mo (archive zip d'un projet, vidéo…). `tags` n'accepte que des tags existants : crée-les d'abord avec `inbox_create_tag`.

## Paramètres

| Nom              | Type                     | Défaut                                      | Rôle                                                         |
| ---------------- | ------------------------ | ------------------------------------------- | ------------------------------------------------------------ |
| `topic`          | `^[A-Za-z0-9_-]{1,128}$` | `default`                                   | Canal du futur message.                                      |
| `tags`           | tableau ≤ 20 de strings  | —                                           | Tags EXISTANTS du registre (`inbox_tags`).                   |
| `correlation_id` | `^[A-Za-z0-9_-]{1,128}$` | —                                           | Identifiant unique du futur message.                         |
| `payload`        | objet JSON               | —                                           | Contenu JSON du futur message.                               |
| `on_download`    | `keep` \| `consume`      | réglage `file_on_download_default` (`keep`) | `consume` : effacé peu après sa première livraison complète. |

## Exemples

- `inbox_upload_link({ topic: "builds", tags: ["ci"], correlation_id: "build-42" })` → URL et `curl` à exécuter (le tag `ci` doit exister).

## Réponse

`{ ok, drop_id, url, curl, expires_at, max_files, max_file_mb }` : `max_files` = `attachments_max_per_message`, `max_file_mb` = plafond le plus haut parmi les catégories acceptées.

## Erreurs

Création du lien (`{ ok: false, error, message }`) :

| Code                       | Sens                                                                       | Que faire                                                  |
| -------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `attachments_disabled`     | Pièces jointes désactivées, ou aucune catégorie acceptée.                  | Prévenir l'administrateur.                                 |
| `invalid_topic`            | Topic hors `^[A-Za-z0-9_-]{1,128}$`.                                       | Corriger le topic.                                         |
| `invalid_correlation_id`   | `correlation_id` hors `^[A-Za-z0-9_-]{1,128}$`.                            | Corriger l'identifiant.                                    |
| `duplicate_correlation_id` | `correlation_id` déjà porté par un message (`existing_id`).                | Choisir un autre identifiant, ou lire `existing_id`.       |
| `payload_too_large`        | `payload` au-delà de `json_max_kb` (sérialisé).                            | Réduire le payload, ou le joindre comme fichier.           |
| `unknown_tags`             | Tag(s) inconnu(s) : `unknown` et `similar` indiquent les proches.          | Créer le tag (`inbox_create_tag`) ou réutiliser un proche. |
| `invalid_name`             | Nom de tag invalide : `^[a-z0-9][a-z0-9-]{0,47}$`.                         | Corriger le nom.                                           |
| `too_many_tags`            | Plus de 20 tags.                                                           | En poser moins.                                            |
| (validation du schéma)     | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus.        |

Réponses HTTP du `curl` d'upload (JSON `{ ok: false, error, message }`) :

| Code                       | Statut | Sens                                                           |
| -------------------------- | ------ | -------------------------------------------------------------- |
| `unavailable`              | 404    | Lien inconnu, expiré, déjà utilisé ou en cours d'utilisation.  |
| `multipart_required`       | 415    | Corps autre que `multipart/form-data` (utiliser `-F`).         |
| `invalid_multipart`        | 400    | Corps multipart invalide.                                      |
| `field_too_large`          | 413    | Champ de formulaire trop long.                                 |
| `no_file`                  | 400    | Aucun fichier reçu.                                            |
| `empty_file`               | 400    | Fichier vide.                                                  |
| `file_too_large`           | 413    | Fichier au-dessus du plafond.                                  |
| `too_many_files`           | 413    | Trop de fichiers dans la requête.                              |
| `drop_full`                | 413    | Le lien n'accepte plus de fichiers.                            |
| `category_not_allowed`     | 415    | Catégorie de fichier refusée.                                  |
| `extension_blocked`        | 415    | Extension refusée.                                             |
| `attachments_disabled`     | 403    | Pièces jointes désactivées.                                    |
| `quota_exceeded`           | 507    | Quota de stockage atteint.                                     |
| `disk_full`                | 507    | Disque du serveur insuffisant.                                 |
| `aborted`                  | 503    | Envoi interrompu.                                              |
| `shutting_down`            | 503    | Le serveur s'arrête.                                           |
| `duplicate_correlation_id` | 409    | `correlation_id` déjà utilisé (`existing_id` dans la réponse). |

Un échec libère le lien : tu peux relancer le même `curl` tant qu'il n'a pas expiré.
