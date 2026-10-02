# queue_status

Vérifie que la file Agent Inbox répond. Renvoie l'état du serveur et une jauge de stockage des fichiers.
Lecture seule, sans effet de bord.

## Paramètres

Aucun.

## Exemples

- `queue_status()` → `{ ok: true, uptime_s, version, storage }`.

## Réponse

`{ ok, uptime_s, version, storage: { used_bytes, reserved_bytes, quota_bytes, disk_free_bytes, min_free_bytes, files_count, accepting } }`. `disk_free_bytes` vaut `null` si l'espace disque est illisible (`accepting` est alors `false`).

## Erreurs

Aucune.
