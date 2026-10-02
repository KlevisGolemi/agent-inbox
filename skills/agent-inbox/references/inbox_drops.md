# inbox_drops

Liste les liens de dépôt (actifs par défaut ; `include_expired: true` pour tout l'historique). Jamais de jeton ni d'URL. Lecture seule.

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `include_expired` | booléen | `false` | Inclure expirés, révoqués et utilisés. |

## Exemples

- `inbox_drops()` → liens actifs.
- `inbox_drops({ include_expired: true })` → historique complet.

## Réponse

`{ ok, drops: [{ id, label, topic, kind, max_files, files_count, max_file_mb, allowed_categories, created_at, expires_at, revoked_at }] }`.

## Erreurs

Aucune.
