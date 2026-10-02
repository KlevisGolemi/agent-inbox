# queue_wait

Attend (long-polling, jusqu'à `timeout_sec` secondes) qu'un message arrive, puis l'emprunte comme `queue_next` (`lease_id` inclus). Filtre optionnel par `topic` OU par `correlation_id` (exclusifs). Si rien n'arrive à temps, renvoie `{ empty: true }` (pas une erreur) : rappeler l'outil pour continuer.

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `topic` | `^[A-Za-z0-9_-]{1,128}$` | — | Canal à attendre. |
| `correlation_id` | `^[A-Za-z0-9_-]{1,128}$` | — | Attendre ce message (exclusif avec `topic`). |
| `timeout_sec` | entier 1–50 | `30` | Attente maximale. |

## Exemples

- `queue_wait({ timeout_sec: 10 })` → attend un message 10 s.
- `queue_wait({ correlation_id: "cmd-123", timeout_sec: 20 })` → attend ce message précis.

## Réponse

`{ ok, empty, item, pending, lease_id }` ou `{ ok, empty: true, item: null }`.

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| `topic_and_correlation_id_are_exclusive` | Les deux filtres sont donnés. | N'en utiliser qu'un seul. |
| `too_many_waiters` | Trop d'attentes simultanées. | Réessayer dans quelques secondes. |
| `leased` | Message déjà emprunté. | Attendre la fin du bail. |
| `already_read` | Message déjà consommé. | Inutile d'attendre. |
