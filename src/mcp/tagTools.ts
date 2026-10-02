import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fail, newTagSchema, resolveFailure, result, tagsSchema } from './common.js'
import type { McpToolDeps } from './tools.js'

export function registerTagTools(server: McpServer, deps: McpToolDeps): void {
  const { tags, repo } = deps

  server.registerTool(
    'queue_tag',
    {
      title: 'Poser ou retirer des tags',
      description:
        'Ajoute (add) ou retire (remove) des tags sur un message (id UUID, pas le correlation_id). add n’accepte que des ' +
        'tags EXISTANTS ; un tag inconnu est refusé avec les tags proches. Pour un tag vraiment nouveau, new_tags ' +
        '[{name, description}] le crée et le pose (anti-doublon). Routine : vérifier → réutiliser → créer en dernier recours.' +
        tags.injectionText(),
      inputSchema: {
        message_id: z.uuid().describe('Identifiant (UUID) du message.'),
        add: tagsSchema.optional().describe('Tags existants à poser.'),
        remove: tagsSchema.optional().describe('Tags à retirer.'),
        new_tags: z.array(newTagSchema).max(20).optional().describe('Tags à créer puis poser.'),
        force_new_tags: z
          .boolean()
          .default(false)
          .describe('Créer new_tags même si un tag proche existe.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ message_id, add, remove, new_tags, force_new_tags }) => {
      if (!repo.findById(message_id)) return fail('not_found', { message_id })
      const r = tags.resolveForMcp({
        tags: add,
        newTags: new_tags,
        createdBy: 'mcp',
        force: force_new_tags,
      })
      if (!r.ok) return resolveFailure(r)
      const current = tags.tagMessage(message_id, r.tags, remove ?? [], r.newTags)
      if (current === null) return fail('not_found', { message_id })
      return result({
        ok: true,
        message_id,
        tags: current,
        ...(r.newTags.length > 0 ? { created: r.newTags.map((t) => t.name) } : {}),
      })
    },
  )

  server.registerTool(
    'inbox_tags',
    {
      title: 'Lister les tags',
      description:
        'Liste le registre de tags partagé (nom, description, usage), du plus utilisé au moins utilisé. ' +
        'À consulter avant de taguer : réutiliser un tag existant plutôt que d’en créer un proche. Lecture seule.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Filtre sur le nom ou la description.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Nombre maximum (1–200).'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      result({
        ok: true,
        tags: tags.list({ ...(query !== undefined ? { query } : {}), limit }).map((t) => ({
          name: t.name,
          description: t.description,
          usage_count: t.usage_count,
          last_used_at: t.last_used_at,
          needs_description: t.needs_description,
        })),
      }),
  )

  server.registerTool(
    'inbox_create_tag',
    {
      title: 'Créer un tag',
      description:
        'Crée un tag dans le registre partagé, avec une description (10 à 280 caractères) qui dit quand l’utiliser. ' +
        'Refusé avec la liste « similar » si un tag proche existe (pluriel, inclusion, faute de frappe) : réutilise-le ' +
        'plutôt. force: true crée quand même. Le nom est normalisé (« Facture Client » → facture-client).',
      inputSchema: {
        name: z.string().min(1).max(60).describe('Nom du tag.'),
        description: z.string().min(10).max(280).describe('Quand utiliser ce tag.'),
        force: z.boolean().default(false).describe('Créer même si un tag proche existe.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ name, description, force }) => {
      const r = tags.create({ name, description, createdBy: 'mcp', force })
      if (!r.ok)
        return fail(r.error, { message: r.message, ...(r.similar ? { similar: r.similar } : {}) })
      return result({ ok: true, tag: r.tag })
    },
  )
}
