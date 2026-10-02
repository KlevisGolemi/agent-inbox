# queue_clear

Supprime TOUS les messages de tous les topics. Irréversible : n'utiliser que sur demande explicite de l'utilisateur. Exige `confirm: true`.

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `confirm` | `true` littéral | — | Doit valoir `true` pour confirmer. |

## Exemples

- `queue_clear({ confirm: true })` → file vidée.

## Réponse

`{ ok, deleted }` (nombre de messages supprimés).

## Erreurs

| Code | Sens | Que faire |
|---|---|---|
| `confirm` | `confirm` manquant ou différent de `true`. | Passer explicitement `confirm: true`. |
