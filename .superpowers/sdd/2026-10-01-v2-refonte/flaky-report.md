# Rapport : tests instables (auth/OAuth et HTTP)

## Symptômes (avant)
Mesures sur macOS, 11 coeurs, Node 24.3, Vitest 5.0.3.

| Scénario | Résultat |
|---|---|
| `npm test` x20, défaut | 17/20 verts |
| `--maxWorkers=1` x20 | 17/20 (2 échecs `cleanup` = faux positifs, voir « Écarté ») |
| 2 suites concurrentes x10 | 8/10 et 7/10 |
| 4 boucles x12 des fichiers HTTP (stress) | 11 runs en échec / 48 |

Échecs observés, tous **sans timeout scrypt** (un seul « Test timed out in 5000ms », sous charge) :
- `Error: read ECONNRESET` (admin, oauth, queue.routes, updater) ;
- statut inattendu : `expected 200 to be 201`, `200 to be 401`, `200 to be 302` ;
- corps `{}` avec statut 200 au lieu de `{clientId, scopes}` (oauth, middleware Bearer) ;
- `expected 202 to be 409` (updater, délai dépassé).

## Hypothèses écartées
- scrypt/CPU : aucun timeout 5 s attribuable ; les échecs persistent à `--maxWorkers=1`.
- Limiteurs de débit partagés : créés par application, pas d'état commun.
- Minuteries de nettoyage : horloge injectée, déterministe.
- Keep-alive de `http.globalAgent` : essayé (agent sans keepAlive), sans effet, abandonné.
- Échecs de `cleanup.test.ts` pendant les mesures : un autre agent a commité
  `f42fa77` (fix du nettoyage des clients OAuth) dans le même arbre de travail pendant les
  boucles ; code et test étaient temporairement désaccordés. Artefact de mesure, pas un flaky.

## Cause racine 1 : collision de port avec un service local (macOS)
Instrumentation temporaire (en-tête `x-trace-srv` pid:port ajouté côté serveur, comparé côté client) :
`MISMATCH resp=undefined wantPort=49152 ... POST /nack/... status=200` : la réponse ne vient d'aucun
de nos serveurs. Or `lsof` montre **Ollama à l'écoute sur 127.0.0.1:49152** (et OrbStack sur
127.0.0.1:59985).

Mécanisme : supertest fait `listen(0)` sans hôte (joker dual-stack `::`) puis se connecte en
`127.0.0.1:<port>`. Sur macOS le noyau accorde le port à ce serveur joker même s'il est déjà pris par
un autre processus lié à `127.0.0.1` précisément ; la connexion en 127.0.0.1 va alors au processus
étranger. Preuve reproductible :

```
wildcard listen on 49152 OK (Ollama also on 127.0.0.1:49152)
GET 127.0.0.1:49152 -> 200 "<!doctype html>..."     (page d'Ollama)
bind explicite 127.0.0.1:49152 -> EADDRINUSE
```
Chaque test HTTP démarre un serveur éphémère (plus de 2000 par run complet) : chaque port tiré a une
petite chance de tomber sur un port étranger, d'où ~2 runs sur 25, uniquement dans les gros fichiers
HTTP, jamais dans un fichier isolé (peu de requêtes). Le code de production n'est pas concerné.

## Cause racine 2 : minuterie réelle de 50 ms (updater)
`updater.test.ts` « délai dépassé » armait un vrai `setTimeout(50 ms)` puis enchaînait deux requêtes
HTTP en attendant 202 puis 409. Sous charge les deux allers-retours dépassent 50 ms : le délai
expire avant la seconde requête (202 reçu). Échec reproduit 5 fois sur 48 runs en stress.

## Corrections
1. `test/setup/loopback-listen.ts` (ajouté à `setupFiles`) : `listen(0)` lie les serveurs de test à
   `127.0.0.1`, de façon synchrone (supertest lit `address()` aussitôt). Bind explicite = port libre
   pour cette adresse, collision impossible.
2. `test/updater.test.ts` : `vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout'] })` et
   `advanceTimersByTimeAsync(50)` ; plus de dépendance au temps réel.
Aucun changement de code de production, aucun timeout rallongé, aucun défaut scrypt modifié.

## Après
| Scénario | Résultat |
|---|---|
| `npm test` x20 consécutifs | **20/20 verts** |
| 2 suites concurrentes, `--maxWorkers=8`, x10 chacune | 10/10 et 10/10 |
| 4 boucles x12 des fichiers HTTP (stress) | 48/48 verts (0 échec, contre 11/48) |
| `npm run check` (lint, typecheck, tests) | vert, 320 tests |

## Note CI
Sur Linux (GitHub Actions) le noyau refuse ce double bind : la cause 1 y est moins probable ; la
cause 2 (temps réel) y était en revanche plus sensible avec 2 vCPU, et est supprimée.
