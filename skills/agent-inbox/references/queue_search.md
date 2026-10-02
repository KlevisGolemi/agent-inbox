# queue_search

Recherche des messages par topic, source, statut, période (since/until, dates ISO) ou texte contenu dans le payload. Renvoie `{ items }` du plus récent au plus ancien, sans rien consommer. Lecture seule.

## Paramètres

| Nom               | Type                            | Défaut | Rôle                                                                                                  |
| ----------------- | ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `topic`           | `^[A-Za-z0-9_-]{1,128}$`        | —      | Canal.                                                                                                |
| `source`          | string 1–100                    | —      | Source exacte (ex. `n8n`, `claude`).                                                                  |
| `status`          | `pending` \| `leased` \| `read` | —      | Statut du message.                                                                                    |
| `since`           | ISO 8601                        | —      | Créés à partir de.                                                                                    |
| `until`           | ISO 8601                        | —      | Créés jusqu'à.                                                                                        |
| `text`            | string 1–500                    | —      | Texte cherché dans le payload.                                                                        |
| `tag`             | string 1–160                    | —      | Tag du registre, ou automatique : `type:<catégorie>`, `source:<source>`, `topic:<topic>`, `external`. |
| `has_attachments` | booléen                         | —      | `true` : avec pièces jointes ; `false` : sans.                                                        |
| `limit`           | entier 1–100                    | `50`   | Nombre maximum.                                                                                       |

## Exemples

- `queue_search({ tag: "facture" })` → messages tagués `facture`.
- `queue_search({ has_attachments: true, status: "pending" })` → messages en attente avec fichiers.

## Réponse

`{ ok, items }`, mêmes champs de message que `queue_peek` (dont `auto_tags` ; `trust` et `warning` si externe). Le tag automatique `external` sélectionne les messages déposés par des tiers.

## Erreurs

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
