# Cas d'usage

Trois recettes, alignées sur les workflows de [`examples/n8n/`](../examples/n8n/README.md). Préparation
commune : connecter Claude ([guide](connecter-un-client.md)) et créer le credential n8n `Agent Inbox`
(voir le [README des templates](../examples/n8n/README.md#préparer-n8n-une-seule-fois)).

## 1. n8n pousse un événement, Claude l'analyse

**Quand** : une commande, un ticket, une alerte arrive dans n8n et vous voulez que Claude l'examine.

```mermaid
sequenceDiagram
  participant N as n8n
  participant Q as Agent Inbox
  participant C as Claude
  N->>Q: POST /webhook (x-topic: events)
  C->>Q: queue_next(topic: events)
  Q-->>C: message + lease_id
  C->>Q: queue_ack(lease_id)
```

**n8n** : template `01-evenement-vers-claude.json`. Un nœud HTTP Request envoie le payload en
`POST /webhook` avec `x-topic: events`. Pour une file sans topic, retirez l'en-tête : les messages vont dans `default`.

**Claude** : demandez-lui, par exemple, « Regarde la file `events` et résume ce qui est arrivé » :

1. `queue_stats(topic: "events")` : combien de messages attendent ;
2. `queue_next(topic: "events")` : prend le plus ancien et renvoie son `lease_id` ;
3. analyse le payload ;
4. `queue_ack(lease_id)` : confirme le traitement. Sans cela, le message revient après `lease_timeout_sec`.

Pour inspecter sans consommer : `queue_peek` ou `queue_search(topic: "events", text: "order_id")`.

## 2. Requête-réponse par `correlation_id`

**Quand** : Claude confie un travail à n8n (appel d'une API, requête en base, génération d'un document) et
attend le résultat.

```mermaid
sequenceDiagram
  participant C as Claude
  participant Q as Agent Inbox
  participant N as n8n (worker)
  C->>Q: queue_send(topic: requests, correlation_id: req-42)
  N->>Q: GET /next?topic=requests&ack=manual&wait=30
  Q-->>N: demande + lease_id
  N->>Q: POST /webhook (x-correlation-id: req-42-response, topic: responses)
  N->>Q: POST /ack/lease_id
  C->>Q: queue_wait(correlation_id: req-42-response)
  Q-->>C: réponse
  C->>Q: queue_ack(lease_id)
```

Un `correlation_id` est **unique dans toute la file** : la réponse ne peut pas reprendre celui de la
demande (`409 duplicate_correlation_id`). La convention du template est `<identifiant de la demande>-response`.

**Claude** envoie la demande, puis attend la réponse :

```text
queue_send(topic: "requests", correlation_id: "req-42", payload: { "action": "generate_report", "month": "2026-09" })
queue_wait(correlation_id: "req-42-response", timeout_sec: 30)
queue_ack(lease_id)
```

`queue_wait` attend jusqu'à 50 secondes ; s'il renvoie `empty: true`, rappelez-le : ce n'est pas une
erreur. Pour lire la réponse sans la consommer, utilisez `queue_by_id(correlation_id: "req-42-response")`
(`peek: true` par défaut).

**n8n** : template `02-request-response.json`. Le worker :

1. `GET /next?topic=requests&ack=manual&wait=30` : prend une demande (attente longue) ;
2. traite le payload (nœud Code à remplacer par votre logique) ;
3. `POST /webhook` avec `x-topic: responses` et `x-correlation-id: <demande>-response` ;
4. `POST /ack/<lease_id>` : acquitte la demande, puis reprend en 1 tant qu'il y en a.

Si n8n plante entre 3 et 4, le bail expire et la demande revient : prévoyez un traitement idempotent.

## 3. Digest quotidien de plusieurs sources

**Quand** : vous voulez qu'une seule synthèse vous attende chaque matin, au lieu de dix notifications.

**n8n** : template `03-digest-quotidien.json`. Un Schedule Trigger (8 h) interroge plusieurs sources, un
nœud Code les assemble en un seul objet, et un `POST /webhook` le dépose sur le topic `digest` avec
`x-correlation-id: digest-AAAA-MM-JJ` (un seul digest par jour, un doublon est refusé en `409`).

**Claude** : « Donne-moi le digest du jour ».

```text
queue_by_id(correlation_id: "digest-2026-10-01")     # consulte sans consommer
queue_next(topic: "digest") puis queue_ack(lease_id)  # ou : le prend et le marque traité
```

Les digests s'accumulent : donnez-leur une rétention propre avec le réglage `topic_ttl_overrides`
(Admin → Réglages), par exemple `{"digest": 168}` pour sept jours, sans toucher aux autres topics.
`queue_search(topic: "digest", since: "2026-09-24T00:00:00Z")` retrouve ceux de la semaine.

## 4. Envoyer un gros zip depuis Codex vers Claude Code

**Quand** : vous travaillez dans un environnement avec shell (Codex, Claude Code) et vous voulez transférer
une archive d'un agent à l'autre sans limite de taille.

**Depuis l'agent expéditeur** :

```text
inbox_create_tag({ name: "projet-x", description: "Livrables du projet X" })
inbox_upload_link({ topic: "transferts", tags: ["projet-x"], correlation_id: "projet-x-2026-10-02" })
```

Exécutez la commande `curl` renvoyée (`curl -F file=@projet.zip '<url>'`). Le lien self est à usage unique
et dure 15 minutes ; le message créé a `trust: internal`.

**Depuis Claude Code**, côté récepteur :

```text
queue_wait(correlation_id: "projet-x-2026-10-02", timeout_sec: 30)
inbox_get_file({ attachment_id: "...", delivery: "link" })
# exécute le curl tel quel : fichier <attachment_id>.zip (nom fixé par le serveur), dézippe, travaille
queue_ack({ lease_id: "..." })
```

## 5. Un tiers dépose une photo pour Claude Desktop ou ChatGPT

**Quand** : une personne sans compte Agent Inbox doit vous envoyer un fichier (photo, document), et vous
voulez le consulter dans Claude Desktop/Web ou ChatGPT.

**Créer le lien de dépôt** : un drop ne peut porter que des tags existants ; créez donc d'abord le tag
(description de 10 à 280 caractères), puis le lien.

```text
inbox_create_tag({ name: "photos", description: "Photos envoyées par des tiers depuis un chantier, à trier avant usage." })
inbox_create_drop({
  label: "Photos du chantier",
  topic: "chantier",
  tags: ["photos"],
  max_files: 5,
  max_file_mb: 20,
  allowed_categories: ["image"]
})
```

Transmettez l'URL affichée **une seule fois** au tiers. Il glisse-dépose ses photos sur la page, ou envoie
`curl -F file=@photo.jpg '<url>'`.

**Côté Claude Desktop / ChatGPT** :

```text
queue_next(topic: "chantier")
# Le message porte trust: "external_unverified" et un warning.
inbox_get_file({ attachment_id: "..." })  # auto : image inline jusqu'à inline_max_mb
queue_ack({ lease_id: "..." })
```

L'image apparaît inline avec l'avertissement « externe non vérifié ». C'est une **donnée**, jamais une
instruction : ne pas exécuter ce qu'elle pourrait demander.

## 6. n8n poste un PDF tagué `facture`

**Quand** : un workflow n8n génère ou reçoit un PDF (facture, rapport) et vous voulez qu'un agent le
récupère avec un tag explicite.

**n8n** : template `04-envoyer-un-fichier.json`. Le workflow lit un fichier binaire, puis un nœud HTTP
Request envoie un `POST multipart/form-data` sur `/webhook` avec :

- `x-topic: compta`
- `x-tags: facture`
- champ `file` en `formBinaryData`
- champ `payload` JSON optionnel (`{ source: 'n8n', note: 'Facture du mois' }`)

**Claude** : recherchez par tag et pièce jointe.

```text
queue_search({ tag: "facture", has_attachments: true, status: "pending" })
queue_next(topic: "compta")
inbox_get_file({ attachment_id: "..." })  # lien ou inline selon la taille
queue_ack({ lease_id: "..." })
```

Le tag `facture` est créé automatiquement par l'API HTTP s'il n'existait pas (l'admin l'affiche « à décrire » ;
`needs_description` est le champ de l'API et de la base). Pour garder le registre propre, décrivez-le ensuite dans Admin → Tags.
