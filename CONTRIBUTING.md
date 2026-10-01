# Contribuer

Les contributions sont les bienvenues : corrections, tests, documentation. Pour un changement important,
ouvrez d'abord une issue afin d'en discuter.

## Mise en place

Prérequis : Node.js 24 ou plus.

```bash
npm ci
npm run dev:ui   # http://localhost:3000/admin, base SQLite dans .dev/
```

Le serveur de développement crée un compte de test ; ses identifiants sont dans `scripts/dev-server.ts`.

## Avant d'ouvrir une pull request

```bash
npm run check    # eslint + tsc --noEmit + vitest
npm run format   # prettier
```

La CI exécute `npm run check` et construit l'image Docker.

## Règles

- **Tests d'abord** pour un correctif ou une fonctionnalité : `test/<module>.test.ts`, Vitest et Supertest,
  base SQLite en mémoire (voir `test/helpers/app.ts`).
- **Commits** : [Conventional Commits](https://www.conventionalcommits.org/fr/) (`feat:`, `fix:`, `docs:`,
  `test:`, `refactor:`, `chore:`), un changement logique par commit.
- **Style** : TypeScript strict, Prettier (sans point-virgule, guillemets simples). Commentaires et messages
  en français ; identifiants de code en anglais.
- **Dépendances** : n'en ajoutez pas sans raison. Les mots de passe utilisent `node:crypto`, le serveur HTTP est Express.
- **Documentation** : mettez à jour `docs/` et `CHANGELOG.md` (section `[Unreleased]`) quand le comportement visible change.
- **Sécurité** : ne publiez pas de faille dans une issue ; suivez [SECURITY.md](SECURITY.md).

Les invariants à ne pas casser (claim atomique, regex unique, réglages en base, MCP sans état…) sont
décrits dans [AGENTS.md](AGENTS.md#contribuer-au-code).
