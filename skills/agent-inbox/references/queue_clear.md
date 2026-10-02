# queue_clear

Supprime TOUS les messages de tous les topics. Irréversible : n'utiliser que sur demande explicite de l'utilisateur. Exige `confirm: true`.

## Paramètres

| Nom       | Type            | Défaut | Rôle                               |
| --------- | --------------- | ------ | ---------------------------------- |
| `confirm` | `true` littéral | —      | Doit valoir `true` pour confirmer. |

## Exemples

- `queue_clear({ confirm: true })` → file vidée.

## Réponse

`{ ok, deleted }` (nombre de messages supprimés).

## Erreurs

| Code                   | Sens                                                                                          | Que faire                             |
| ---------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| (validation du schéma) | `confirm` absent ou différent de `true` : rejet par la validation du schéma, avant exécution. | Passer explicitement `confirm: true`. |
