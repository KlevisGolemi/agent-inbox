# Templates n8n

Trois workflows prêts à importer, qui n'utilisent que des nœuds standard de n8n (Schedule Trigger,
Manual Trigger, Webhook, HTTP Request, Set, IF, Code). Les recettes complètes, côté Claude comprises,
sont dans [docs/cas-d-usage.md](../../docs/cas-d-usage.md).

| Fichier | Recette |
|---|---|
| [`01-evenement-vers-claude.json`](01-evenement-vers-claude.json) | Un événement (webhook n8n ou test manuel) est déposé sur le topic `events`. |
| [`02-request-response.json`](02-request-response.json) | Un worker prend les demandes du topic `requests`, les traite, publie la réponse puis acquitte. |
| [`03-digest-quotidien.json`](03-digest-quotidien.json) | Chaque matin, plusieurs sources sont réunies en un seul message sur le topic `digest`. |
| [`04-envoyer-un-fichier.json`](04-envoyer-un-fichier.json) | Un fichier (PDF, image…) est posté en `multipart/form-data` sur `/webhook`, avec `x-tags`. |

## Préparer n8n (une seule fois)

1. **Credential.** *Credentials → Create → Header Auth*, nommé exactement `Agent Inbox` :
   *Name* `x-webhook-secret`, *Value* le secret du webhook (Admin → Réglages de Agent Inbox).
2. **Variable d'environnement.** Sur l'instance n8n, définissez `AGENT_INBOX_URL` avec l'URL publique de
   Agent Inbox, sans barre oblique finale (par exemple `https://queue.example.com`). Les nœuds la lisent
   avec `{{ $env.AGENT_INBOX_URL }}`. Si votre n8n bloque l'accès à `$env` (`N8N_BLOCK_ENV_ACCESS_IN_NODE`),
   autorisez-le ou remplacez l'expression par l'URL en clair dans chaque nœud HTTP Request.

Aucun fichier ne contient de secret : les workflows désignent le credential par son nom.

## Importer

*Workflows → ⋯ → Import from file*, choisissez un fichier. Ouvrez chaque nœud HTTP Request qui porte un
avertissement et sélectionnez le credential `Agent Inbox` s'il n'est pas déjà relié. Les workflows sont
importés **inactifs**.

## Tester

- **01** : cliquez sur *Execute workflow* (Test manuel). Le message apparaît dans Admin → Queue Explorer, topic
  `events`. Pour l'URL de test du nœud Webhook, envoyez un `POST` JSON : le corps devient le payload.
- **02** : déposez une demande, par exemple depuis Claude (`queue_send` avec `topic: "requests"` et
  `correlation_id: "req-1"`) ou avec `curl`, puis exécutez le workflow : la réponse arrive sur le topic
  `responses` avec le `correlation_id` `req-1-response`. Détails dans la [recette](../../docs/cas-d-usage.md#2-requête-réponse-par-correlation_id).
- **03** : exécutez le workflow à la main. Le digest porte le `correlation_id` `digest-AAAA-MM-JJ` : un second
  envoi le même jour reçoit `409 duplicate_correlation_id`, ce qui évite les doublons.

## À savoir

- **02 boucle tant que la file contient des demandes** (après l'acquittement, le workflow reprend en
  `GET /next`) et s'arrête quand l'attente de 30 s ne ramène rien. Activé, il se relance chaque minute ;
  deux exécutions simultanées sont sans danger, car la prise d'un message est atomique.
- **02 est à adapter** : le nœud « Traiter la demande » renvoie une réponse factice. Remplacez-le par votre traitement.
  Si l'envoi de la réponse échoue, la demande n'est pas acquittée et revient après `lease_timeout_sec` (300 s par défaut).
- **03** interroge les API publiques de GitHub (versions de n8n et du SDK MCP) et `GET /stats` de la file.
  Remplacez ces nœuds par vos propres sources ; gardez le nœud « Composer le digest » comme point de jonction.
