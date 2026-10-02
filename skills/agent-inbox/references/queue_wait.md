# queue_wait

Attend (long-polling, jusqu'à `timeout_sec` secondes) qu'un message arrive, puis l'emprunte comme `queue_next` (`lease_id` inclus). Filtre optionnel par `topic` OU par `correlation_id` (exclusifs). Si rien n'arrive à temps, renvoie `{ empty: true }` (pas une erreur) : rappeler l'outil pour continuer.

## Paramètres

| Nom              | Type                     | Défaut | Rôle                                         |
| ---------------- | ------------------------ | ------ | -------------------------------------------- |
| `topic`          | `^[A-Za-z0-9_-]{1,128}$` | —      | Canal à attendre.                            |
| `correlation_id` | `^[A-Za-z0-9_-]{1,128}$` | —      | Attendre ce message (exclusif avec `topic`). |
| `timeout_sec`    | entier 1–50              | `30`   | Attente maximale.                            |

## Exemples

- `queue_wait({ timeout_sec: 10 })` → attend un message 10 s.
- `queue_wait({ correlation_id: "cmd-123", timeout_sec: 20 })` → attend ce message précis.

## Réponse

`{ ok, empty: false, item: { id, source, correlation_id, topic, created_at, read_at, lease_until, lease_id, attempts, attachments, tags, auto_tags, payload }, pending }` (plus `trust` et `warning` pour un message externe). Le `lease_id` est dans `item.lease_id` (format `<id>.<tentative>`). Délai écoulé sans message : `{ ok: true, empty: true, item: null }`.

## Erreurs

| Code                                     | Sens                                                                       | Que faire                                           |
| ---------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `topic_and_correlation_id_are_exclusive` | Les deux filtres sont donnés.                                              | N'en utiliser qu'un seul.                           |
| `too_many_waiters`                       | Trop d'attentes simultanées.                                               | Réessayer dans quelques secondes.                   |
| `leased`                                 | Avec `correlation_id` : message déjà emprunté.                             | Attendre la fin du bail.                            |
| `already_read`                           | Avec `correlation_id` : message déjà consommé.                             | Inutile d'attendre.                                 |
| (validation du schéma)                   | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
