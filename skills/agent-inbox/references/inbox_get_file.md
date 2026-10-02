# inbox_get_file

Récupère une pièce jointe par son identifiant. Modifie l'état seulement si la pièce est `consume` (comptée comme livrée).

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `attachment_id` | uuid | — | `attachments[].id` d'un message. |
| `delivery` | `auto` \| `inline` \| `link` | `auto` | `auto` : image/son inline jusqu'à `inline_max_mb`, texte jusqu'à 1 Mo, sinon lien. |

## Exemples

- Client avec shell : `{"attachment_id": "…", "delivery": "link"}` puis exécuter le `curl` renvoyé (`curl -fLJO '<url>'`).
- Client sans shell : `{"attachment_id": "…"}` ; si la réponse est un lien, le donner à l'utilisateur.

## Réponse

`{ ok, delivery, attachment: {id, filename, mime_type, category, size_bytes, sha256, on_download, expires_at, status} }`,
plus `url`, `expires_at`, `curl` (et `note`) pour un lien ; plus `trust` et `warning` si le message est externe
(le bloc d'avertissement précède alors le contenu inline).

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| `not_found` | Identifiant inconnu. | Relire `attachments` du message. |
| `expired` | Rétention écoulée. | Demander un nouvel envoi. |
| `consumed` | Pièce `consume` déjà livrée, délai de grâce écoulé. | Demander un nouvel envoi. |
| `file_gone` | Fichier absent du disque (ex. après restauration). | Demander un nouvel envoi. |
