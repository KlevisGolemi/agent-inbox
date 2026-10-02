import { z } from 'zod'
import type { ResolveResult } from '../tags/registry.js'

/** Résultat d'outil : texte JSON + contenu structuré ; `isError` pour les erreurs métier. */
export function result(x: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(x, null, 2) }],
    structuredContent: x,
    ...(isError ? { isError: true as const } : {}),
  }
}
export const fail = (error: string, extra: Record<string, unknown> = {}) =>
  result({ ok: false, error, ...extra }, true)

/** Refus de résolution des tags (aucune écriture n'a eu lieu). */
export function resolveFailure(r: Extract<ResolveResult, { ok: false }>) {
  return fail(r.error, {
    message: r.message,
    hint: r.hint,
    ...(r.unknown ? { unknown: r.unknown } : {}),
    ...(r.similar ? { similar: r.similar } : {}),
  })
}

export const tagsSchema = z.array(z.string().min(1).max(60)).max(20)
export const newTagSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .describe('Nom du tag (normalisé : minuscules sans accents, tirets).'),
  description: z.string().min(10).max(280).describe('À quoi sert ce tag (10 à 280 caractères).'),
})
