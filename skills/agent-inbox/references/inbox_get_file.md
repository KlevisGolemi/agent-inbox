# inbox_get_file

Récupère une pièce jointe par son identifiant. Modifie l'état seulement si la pièce est `consume` (comptée comme livrée).

## Paramètres

| Nom             | Type                         | Défaut | Rôle                                    |
| --------------- | ---------------------------- | ------ | --------------------------------------- |
| `attachment_id` | uuid                         | —      | `attachments[].id` d'un message.        |
| `delivery`      | `auto` \| `inline` \| `link` | `auto` | Mode de livraison, détaillé ci-dessous. |

Modes (`inline_max_mb` : 5 Mo par défaut ; `0` désactive l'inline) :

- `auto` : inline si la pièce est une image ou un son de taille au plus `inline_max_mb`, ou un texte d'au plus 1 Mo (et `inline_max_mb`) ; sinon lien signé.
- `inline` : tente l'inline pour tout type, jusqu'à `inline_max_mb` (un type non texte/image/son part en ressource binaire base64). Si c'est impossible, renvoie un lien avec un `note` : type actif (SVG, HTML, XML, scripts) jamais livré inline, ou pièce trop volumineuse.
- `link` : toujours un lien signé temporaire (`download_link_ttl_min`, 60 min par défaut), sans limite de taille.

## Exemples

- Client avec shell : `{"attachment_id": "…", "delivery": "link"}` puis exécuter le `curl` renvoyé (`curl -fLJO '<url>'`).
- Client sans shell : `{"attachment_id": "…"}` ; si la réponse est un lien, le donner à l'utilisateur.

## Réponse

Toujours : `{ ok, delivery, attachment: { id, filename, mime_type, category, size_bytes, sha256, on_download, expires_at, status } }`.

- `delivery: "inline"` : le contenu suit comme bloc MCP (image, son, texte ou ressource binaire).
- `delivery: "link"` : plus `url`, `expires_at`, `curl` et, selon le cas, `note`.
- Pièce d'un message externe : plus `trust: "external_unverified"` et `warning` ; le bloc d'avertissement précède alors le contenu inline.

Décompte `consume` : pour une pièce `on_download: "consume"`, la livraison inline complète compte comme livrée ; en mode lien, c'est la fin du téléchargement HTTP. Le fichier est effacé peu après (délai de grâce).

## Erreurs

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `not_found`            | Identifiant inconnu.                                                       | Relire `attachments` du message.                    |
| `expired`              | Rétention écoulée ou fichier déjà supprimé.                                | Demander un nouvel envoi.                           |
| `consumed`             | Pièce `consume` déjà livrée, délai de grâce écoulé.                        | Demander un nouvel envoi.                           |
| `file_gone`            | Fichier absent du disque (ex. après restauration).                         | Demander un nouvel envoi.                           |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
