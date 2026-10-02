import { Readable } from 'node:stream'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { newAttachments, type AttachmentsRepo } from '../files/attachments.js'
import { decodeBase64Attachments } from '../files/base64.js'
import { attachmentSummary } from '../files/http.js'
import type { FileStore } from '../files/store.js'
import { UploadError, type UploadManager, type UploadSession } from '../files/uploads.js'
import { log } from '../log.js'
import {
  claimedView,
  itemView,
  TooManyWaitersError,
  waitForClaim,
  type WaitPool,
} from '../queue/http.js'
import type { AckResult, EnqueueResult, QueueRepo, QueueItem } from '../queue/repo.js'
import { CORRELATION_ID_REGEX, TOPIC_REGEX } from '../queue/validation.js'
import type { Settings } from '../settings/index.js'
import type { NewTag } from '../tags/attach.js'
import type { TagRegistry } from '../tags/registry.js'
import { fail, newTagSchema, resolveFailure, result, tagsSchema } from './common.js'
import { registerFileTools } from './fileTools.js'
import { registerTagTools } from './tagTools.js'

export interface McpToolDeps {
  repo: QueueRepo
  settings: Settings
  version: string
  waits: WaitPool
  files: FileStore
  uploads: UploadManager
  attachments: AttachmentsRepo
  tags: TagRegistry
  publicUrl: URL
}

const topicSchema = z
  .string()
  .regex(TOPIC_REGEX, 'Topic invalide : ^[A-Za-z0-9_-]{1,128}$')
  .optional()
  .describe('Canal de la file (défaut : tous les topics en lecture, « default » en écriture).')
const correlationSchema = z
  .string()
  .regex(CORRELATION_ID_REGEX, 'Format attendu : ^[A-Za-z0-9_-]{1,128}$')

const LEASE_HINT =
  'Le message est emprunté (bail limité dans le temps) : appelle queue_ack({lease_id}) une fois ' +
  'traité, ou queue_nack({lease_id}) pour le remettre en file ; sans ack il sera servi à nouveau ' +
  "à l'expiration du bail."

/** Réponse commune à queue_next / queue_wait / queue_by_id(peek:false) pour un message emprunté. */
function claimedResult(repo: QueueRepo, settings: Settings, item: QueueItem | null) {
  if (!item) return result({ ok: true, empty: true, item: null })
  return result({
    ok: true,
    empty: false,
    item: claimedView(item, settings.get('ttl_hours')),
    pending: repo.stats().pending,
  })
}

function ackOutcome(outcome: AckResult) {
  if (outcome === 'ok') return result({ ok: true })
  return fail(outcome)
}

export function registerTools(server: McpServer, deps: McpToolDeps): void {
  const { repo, settings, version, waits, tags, uploads } = deps
  const topicOpt = (topic: string | undefined) => (topic !== undefined ? { topic } : {})

  server.registerTool(
    'queue_status',
    {
      title: 'État du serveur',
      description:
        'Vérifie que la file Agent Inbox répond. Renvoie { ok, uptime_s, version, storage } (jauge de stockage des fichiers). ' +
        'Lecture seule, sans effet de bord.',
      annotations: { readOnlyHint: true },
    },
    () =>
      result({
        ok: true,
        uptime_s: Math.floor(process.uptime()),
        version,
        storage: uploads.snapshot(),
      }),
  )

  server.registerTool(
    'queue_stats',
    {
      title: 'Statistiques de la file',
      description:
        'Compte les messages (total, pending, leased, read_count) et leur répartition par topic. ' +
        'À utiliser pour savoir s’il y a du travail en attente avant queue_next. Lecture seule.',
      inputSchema: { topic: topicSchema },
      annotations: { readOnlyHint: true },
    },
    ({ topic }) =>
      result({
        ok: true,
        ttl_hours: settings.get('ttl_hours'),
        stats: repo.stats(topicOpt(topic)),
        storage: uploads.snapshot(),
      }),
  )

  server.registerTool(
    'queue_peek',
    {
      title: 'Lister les messages',
      description:
        'Liste les messages du plus récent au plus ancien, avec leur statut (pending, leased, read), ' +
        'SANS les consommer. Renvoie { stats, limit, offset, items }. Lecture seule : ' +
        'à privilégier pour inspecter la file.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50).describe('Nombre de messages (1–100).'),
        offset: z.number().int().min(0).default(0).describe('Décalage pour la pagination.'),
        topic: topicSchema,
      },
      annotations: { readOnlyHint: true },
    },
    ({ limit, offset, topic }) =>
      result({
        ok: true,
        stats: repo.stats(topicOpt(topic)),
        limit,
        offset,
        items: repo.peek(limit, offset, topicOpt(topic)).map(itemView),
      }),
  )

  server.registerTool(
    'queue_search',
    {
      title: 'Rechercher des messages',
      description:
        'Recherche des messages par topic, source, statut, période (since/until, dates ISO) ou texte ' +
        'contenu dans le payload. Renvoie { items } (du plus récent au plus ancien), sans rien consommer. ' +
        'Lecture seule.',
      inputSchema: {
        topic: topicSchema,
        source: z.string().min(1).max(100).optional().describe('Source exacte (ex. n8n, claude).'),
        status: z.enum(['pending', 'leased', 'read']).optional().describe('Statut du message.'),
        since: z.iso
          .datetime({ offset: true })
          .optional()
          .describe('Créés à partir de (ISO 8601).'),
        until: z.iso.datetime({ offset: true }).optional().describe('Créés jusqu’à (ISO 8601).'),
        text: z.string().min(1).max(500).optional().describe('Texte cherché dans le payload.'),
        tag: z
          .string()
          .min(1)
          .max(160)
          .optional()
          .describe(
            'Tag du registre, ou automatique : type:<catégorie>, source:<source>, topic:<topic>, external.',
          ),
        has_attachments: z
          .boolean()
          .optional()
          .describe('true : seulement les messages avec pièces jointes ; false : sans.'),
        limit: z.number().int().min(1).max(100).default(50).describe('Nombre maximum (1–100).'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ topic, source, status, since, until, text, tag, has_attachments, limit }) =>
      result({
        ok: true,
        items: repo
          .search({
            ...topicOpt(topic),
            ...(source !== undefined ? { source } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(since !== undefined ? { since: Date.parse(since) } : {}),
            ...(until !== undefined ? { until: Date.parse(until) } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(tag !== undefined ? { tag } : {}),
            ...(has_attachments !== undefined ? { hasAttachments: has_attachments } : {}),
            limit,
          })
          .map(itemView),
      }),
  )

  server.registerTool(
    'queue_by_id',
    {
      title: 'Message par correlation_id',
      description:
        'Récupère le message portant ce correlation_id. Par défaut (peek: true) il est seulement ' +
        'consulté : rien ne change. Avec peek: false il est EMPRUNTÉ (destructif) et renvoie un lease_id. ' +
        LEASE_HINT +
        ' Erreurs : not_found, already_read (déjà consommé), leased (emprunté par un autre).',
      inputSchema: {
        correlation_id: correlationSchema.describe('Identifiant de corrélation du message.'),
        peek: z.boolean().default(true).describe('true = consulter seulement ; false = emprunter.'),
      },
      annotations: { destructiveHint: true },
    },
    ({ correlation_id, peek }) => {
      if (peek) {
        const msg = repo.findByCorrelation(correlation_id)
        if (!msg) return fail('not_found', { correlation_id })
        return result({ ok: true, peek: true, item: itemView(msg) })
      }
      const claimed = repo.claimByCorrelation(correlation_id, { lease: true })
      if ('item' in claimed) return claimedResult(repo, settings, claimed.item)
      if (claimed.error === 'leased') return fail('leased', { lease_until: claimed.lease_until })
      if (claimed.error === 'already_read')
        return fail('already_read', { id: claimed.id, read_at: claimed.read_at })
      return fail('not_found', { correlation_id })
    },
  )

  server.registerTool(
    'queue_next',
    {
      title: 'Prendre le prochain message',
      description:
        'Emprunte le plus ancien message en attente (ordre d’arrivée) et le renvoie avec son lease_id ; ' +
        'renvoie { empty: true } si la file est vide. Effet de bord : le message passe en « leased ». ' +
        LEASE_HINT,
      inputSchema: { topic: topicSchema },
      annotations: { destructiveHint: true },
    },
    ({ topic }) =>
      claimedResult(repo, settings, repo.claimNext({ lease: true, ...topicOpt(topic) })),
  )

  server.registerTool(
    'queue_wait',
    {
      title: 'Attendre un message',
      description:
        'Attend (long-polling, jusqu’à timeout_sec secondes) qu’un message arrive, puis l’emprunte comme ' +
        'queue_next (lease_id inclus). Filtre optionnel par topic OU par correlation_id (exclusifs). ' +
        'Si rien n’arrive à temps, renvoie { empty: true } (pas une erreur) : rappelle l’outil pour continuer. ' +
        LEASE_HINT,
      inputSchema: {
        topic: topicSchema,
        correlation_id: correlationSchema
          .optional()
          .describe('Attendre le message portant ce correlation_id (exclusif avec topic).'),
        timeout_sec: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(30)
          .describe('Attente maximale (1–50 s).'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ topic, correlation_id, timeout_sec }, extra) => {
      if (topic !== undefined && correlation_id !== undefined)
        return fail('topic_and_correlation_id_are_exclusive')
      try {
        return await waitTool(topic, correlation_id, timeout_sec, extra.signal)
      } catch (err) {
        if (!(err instanceof TooManyWaitersError)) throw err
        return fail('too_many_waiters', {
          message: `Trop d’attentes simultanées (maximum ${waits.max}) : réessaie dans quelques secondes.`,
        })
      }
    },
  )

  async function waitTool(
    topic: string | undefined,
    correlation_id: string | undefined,
    timeout_sec: number,
    signal: AbortSignal,
  ) {
    if (correlation_id === undefined) {
      const item = await waitForClaim({
        repo,
        pool: waits,
        signal,
        topic,
        waitSec: timeout_sec,
        claim: () => repo.claimNext({ lease: true, ...topicOpt(topic) }),
      })
      return claimedResult(repo, settings, item)
    }
    // Par correlation_id : un message déjà consommé ou emprunté est une erreur immédiate ;
    // absent, on attend son arrivée.
    const first = repo.claimByCorrelation(correlation_id, { lease: true })
    if ('item' in first) return claimedResult(repo, settings, first.item)
    if (first.error === 'leased') return fail('leased', { lease_until: first.lease_until })
    if (first.error === 'already_read')
      return fail('already_read', { id: first.id, read_at: first.read_at })
    const item = await waitForClaim({
      repo,
      pool: waits,
      signal,
      topic: undefined,
      waitSec: timeout_sec,
      claim: () => {
        const r = repo.claimByCorrelation(correlation_id, { lease: true })
        return 'item' in r ? r.item : null
      },
    })
    return claimedResult(repo, settings, item)
  }

  for (const kind of ['ack', 'nack'] as const) {
    server.registerTool(
      `queue_${kind}`,
      {
        title: kind === 'ack' ? 'Acquitter un message' : 'Rendre un message',
        description:
          kind === 'ack'
            ? 'Confirme qu’un message emprunté a été traité (statut → read). À appeler avec le lease_id reçu de ' +
              'queue_next / queue_wait / queue_by_id. Erreurs : invalid_lease, not_found, not_leased (déjà ' +
              'acquitté, rendu ou ré-emprunté).'
            : 'Rend un message emprunté à la file (statut → pending) quand tu ne peux pas le traiter : il sera ' +
              'servi à nouveau. À appeler avec le lease_id reçu. Erreurs : invalid_lease, not_found, not_leased.',
        inputSchema: {
          lease_id: z.string().min(1).max(100).describe('lease_id renvoyé à l’emprunt.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      ({ lease_id }) => ackOutcome(repo[kind](lease_id)),
    )
  }

  const attachmentSchema = z.object({
    filename: z.string().min(1).max(255).describe('Nom du fichier (ex. rapport.pdf).'),
    mime_type: z
      .string()
      .max(255)
      .optional()
      .describe('Type déclaré, indicatif : le serveur détecte le vrai type.'),
    data_base64: z.string().min(1).describe('Contenu encodé en base64.'),
  })

  server.registerTool(
    'queue_send',
    {
      title: 'Envoyer un message',
      description:
        'Ajoute un message dans la file (ex. une réponse ou une tâche pour n8n). Renvoie { id, pending, topic }. ' +
        'correlation_id (optionnel) doit être unique : un doublon renvoie l’erreur duplicate_correlation_id. ' +
        'Fichiers : attachments [{filename, data_base64}] pour de petits fichiers (total décodé limité par mcp_upload_max_mb) ; ' +
        'pour un gros fichier, appelle inbox_upload_link puis curl. ' +
        'Tags : tags n’accepte que des tags EXISTANTS (un tag inconnu est refusé avec les tags proches) ; ' +
        'routine : réutiliser un tag existant, sinon new_tags [{name, description}].' +
        tags.injectionText(),
      inputSchema: {
        payload: z.record(z.string(), z.unknown()).describe('Contenu JSON (objet) du message.'),
        correlation_id: correlationSchema
          .optional()
          .describe('Identifiant unique pour retrouver le message.'),
        source: z.string().min(1).max(100).default('claude').describe('Origine du message.'),
        topic: topicSchema,
        attachments: z
          .array(attachmentSchema)
          .max(50)
          .optional()
          .describe('Fichiers joints, en base64.'),
        tags: tagsSchema.optional().describe('Tags existants du registre (voir inbox_tags).'),
        new_tags: z
          .array(newTagSchema)
          .max(20)
          .optional()
          .describe('Tags à créer puis poser (anti-doublon).'),
        force_new_tags: z
          .boolean()
          .default(false)
          .describe('Créer new_tags même si un tag proche existe.'),
        on_download: z
          .enum(['keep', 'consume'])
          .optional()
          .describe(
            'consume : fichier effacé peu après sa première livraison complète (défaut : réglage du serveur).',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      payload,
      correlation_id,
      source,
      topic,
      attachments,
      tags: tagList,
      new_tags,
      force_new_tags,
      on_download,
    }) => {
      const t = topic ?? 'default'
      // R11 : tout est validé (tags, tailles, base64) avant la moindre écriture ; les tags
      // éventuels sont créés dans la transaction d'enqueue.
      let existing: string[] = []
      let fresh: NewTag[] = []
      if ((tagList?.length ?? 0) + (new_tags?.length ?? 0) > 0) {
        const r = tags.resolveForMcp({
          ...(tagList ? { tags: tagList } : {}),
          ...(new_tags ? { newTags: new_tags } : {}),
          createdBy: `mcp:${source}`,
          force: force_new_tags,
        })
        if (!r.ok) return resolveFailure(r)
        existing = r.tags
        fresh = r.newTags
      }
      const names = [...existing, ...fresh.map((n) => n.name)]
      const base = {
        payload,
        source,
        correlationId: correlation_id ?? null,
        topic: t,
        tags: existing,
        newTags: fresh,
      }
      const done = (out: EnqueueResult, files?: ReturnType<typeof attachmentSummary>) => {
        if (!out.ok)
          return fail('duplicate_correlation_id', {
            correlation_id,
            existing_id: out.existingId,
          })
        log('info', 'Message mis en file (MCP)', {
          id: out.id,
          source,
          topic: t,
          files: files?.length ?? 0,
        })
        return result({
          ok: true,
          id: out.id,
          correlation_id: correlation_id ?? null,
          pending: out.pending,
          topic: t,
          ...(names.length > 0 ? { tags: names } : {}),
          ...(files ? { attachments: files } : {}),
        })
      }
      if (!attachments?.length) return done(repo.enqueue(base))
      const decoded = decodeBase64Attachments(attachments, settings.get('mcp_upload_max_mb'))
      if (!decoded.ok) return fail(decoded.error, { message: decoded.message })
      let session: UploadSession
      try {
        session = uploads.begin()
      } catch (err) {
        if (err instanceof UploadError) return fail(err.code, { message: err.message })
        throw err
      }
      try {
        for (const f of decoded.files) await session.stage(Readable.from([f.data]), f.filename)
        const out = session.commit((files) =>
          repo.enqueue({
            ...base,
            attachments: newAttachments(
              files,
              on_download ?? settings.get('file_on_download_default'),
              settings,
              Date.now(),
            ),
          }),
        )
        return done(out, attachmentSummary(session.staged))
      } catch (err) {
        await session.abort()
        if (err instanceof UploadError) return fail(err.code, { message: err.message })
        throw err
      }
    },
  )

  server.registerTool(
    'queue_delete',
    {
      title: 'Supprimer un message',
      description:
        'Supprime définitivement un message par son id (UUID, pas le correlation_id). Irréversible. ' +
        'Erreur not_found si l’id n’existe pas.',
      inputSchema: { id: z.uuid().describe('Identifiant (UUID) du message.') },
      annotations: { destructiveHint: true },
    },
    ({ id }) => {
      if (!repo.deleteById(id)) return fail('not_found', { id })
      log('info', 'Message supprimé (MCP)', { id })
      return result({ ok: true, deleted: id })
    },
  )

  server.registerTool(
    'queue_clear',
    {
      title: 'Vider la file',
      description:
        'Supprime TOUS les messages de tous les topics. Irréversible : n’utiliser que sur demande explicite ' +
        'de l’utilisateur. Exige confirm: true. Renvoie { deleted } (nombre de messages supprimés).',
      inputSchema: { confirm: z.literal(true).describe('Doit valoir true pour confirmer.') },
      annotations: { destructiveHint: true },
    },
    () => {
      const deleted = repo.clear()
      log('warn', 'File vidée (MCP)', { deleted })
      return result({ ok: true, deleted })
    },
  )

  registerTagTools(server, deps)
  registerFileTools(server, deps)
}
