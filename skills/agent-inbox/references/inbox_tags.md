# inbox_tags

Liste le registre de tags partagé (nom, description, usage), du plus utilisé au moins utilisé. À consulter avant de taguer : réutiliser un tag existant plutôt que d'en créer un proche. Lecture seule.

## Paramètres

| Nom | Type | Défaut | Rôle |
|---|---|---|---|
| `query` | string 1–100 | — | Filtre sur le nom ou la description. |
| `limit` | entier 1–200 | `50` | Nombre maximum. |

## Exemples

- `inbox_tags({ limit: 200 })` → tous les tags.
- `inbox_tags({ query: "facture" })` → tags contenant « facture ».

## Réponse

`{ ok, tags: [{ name, description, usage_count, last_used_at, needs_description }] }`.

## Erreurs

Aucune.
