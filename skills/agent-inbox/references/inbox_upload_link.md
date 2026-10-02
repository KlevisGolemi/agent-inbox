# inbox_upload_link

Crée un lien d'upload à usage unique (15 min) pour déposer un ou plusieurs fichiers depuis un shell, sans limite pratique de taille : exécute ensuite la commande `curl` renvoyée (`curl -F file=@chemin <url>`, un `-F` par fichier). Le message créé porte `topic`, `tags`, `correlation_id` et `payload` donnés ici ; trust interne. À préférer à `queue_send.attachments` dès qu'un fichier dépasse quelques Mo (archive zip d'un projet, vidéo…).

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `topic` | `^[A-Za-z0-9_-]{1,128}$` | `default` | Canal du futur message. |
| `tags` | tableau de strings | — | Tags EXISTANTS du registre (`inbox_tags` ; crée-les d'abord avec `inbox_create_tag`). |
| `correlation_id` | `^[A-Za-z0-9_-]{1,128}$` | — | Identifiant unique du futur message. |
| `payload` | objet JSON | — | Contenu JSON du futur message. |
| `on_download` | `keep` \| `consume` | réglage serveur | `consume` : effacé après la première livraison. |

## Exemples

- `inbox_upload_link({ topic: "builds", tags: ["ci"], correlation_id: "build-42" })` → URL et curl à exécuter.

## Réponse

`{ ok, drop_id, url, curl, expires_at, max_files, max_file_mb }`.

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| `attachments_disabled` | Pièces jointes désactivées. | Contacter l'administrateur. |
| `unknown_tags` | Tag(s) inconnu(s). | Créer les tags d'abord. |
| `invalid_topic` | Topic invalide. | Vérifier le format. |
| `invalid_correlation_id` | Correlation ID invalide. | Vérifier le format. |
| `duplicate_correlation_id` | (HTTP 409) Déjà utilisé. | Choisir un autre identifiant. |
| `unavailable` | (HTTP 404) Lien invalide, expiré ou épuisé. | Créer un nouveau lien. |
