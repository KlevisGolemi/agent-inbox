# inbox_drops

Liste les liens de dépôt (actifs par défaut ; `include_expired: true` pour tout l'historique). Jamais de jeton ni d'URL. Lecture seule.

## Paramètres

| Nom               | Type    | Défaut  | Rôle                                            |
| ----------------- | ------- | ------- | ----------------------------------------------- |
| `include_expired` | booléen | `false` | Inclure expirés, révoqués, épuisés et utilisés. |

## Exemples

- `inbox_drops()` → liens actifs.
- `inbox_drops({ include_expired: true })` → historique complet.

## Réponse

`{ ok, drops: [{ id, kind, label, topic, tags, max_files, files_count, max_file_mb, allowed_categories, correlation_id, on_download, created_by, created_at, expires_at, revoked_at, status }] }`.

- `kind` : `public` (lien de dépôt pour un tiers) ou `self` (lien d'upload créé par `inbox_upload_link`).
- `status` : `active`, `expired`, `revoked`, `exhausted` ou `used`.
- `correlation_id` et `on_download` ne sont renseignés que pour les liens `self` (sinon `null`).

## Erreurs

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
