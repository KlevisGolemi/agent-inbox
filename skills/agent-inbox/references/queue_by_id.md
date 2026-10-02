# queue_by_id

Récupère le message portant ce `correlation_id`. Par défaut (`peek: true`) il est seulement consulté : rien ne change. Avec `peek: false` il est EMPRUNTÉ (destructif) et renvoie un `lease_id`.

## Paramètres

| Nom              | Type                     | Défaut | Rôle                                      |
| ---------------- | ------------------------ | ------ | ----------------------------------------- |
| `correlation_id` | `^[A-Za-z0-9_-]{1,128}$` | —      | Identifiant de corrélation du message.    |
| `peek`           | booléen                  | `true` | `true` = consulter ; `false` = emprunter. |

## Exemples

- `queue_by_id({ correlation_id: "cmd-123" })` → consultation.
- `queue_by_id({ correlation_id: "cmd-123", peek: false })` → emprunt avec `lease_id`.

## Réponse

Consultation (`peek: true`) : `{ ok, peek: true, item }`, sans `lease_id`. Emprunt (`peek: false`) : `{ ok, empty: false, item, pending }` ; le `lease_id` est dans `item.lease_id`.

## Erreurs

| Code                   | Sens                                                                       | Que faire                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `not_found`            | Identifiant inconnu.                                                       | Vérifier le `correlation_id`.                       |
| `already_read`         | Déjà consommé.                                                             | Le message a déjà été traité.                       |
| `leased`               | Emprunté par un autre.                                                     | Attendre la fin du bail ou utiliser `queue_wait`.   |
| (validation du schéma) | Paramètres invalides : rejet par la validation du schéma, avant exécution. | Respecter les types et bornes du tableau ci-dessus. |
