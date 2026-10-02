import type { Settings } from '../settings/index.js'
import { MB, type FileCategory } from './types.js'

const HOUR_MS = 3_600_000

/** Échéance d'une pièce : rétention de sa catégorie, plafonnée pour les gros fichiers. */
export function computeExpiresAt(
  input: { createdAt: number; category: FileCategory; sizeBytes: number },
  settings: Settings,
): number {
  let hours = settings.get('file_retention_hours')[input.category]
  if (input.sizeBytes > settings.get('file_retention_large_mb') * MB) {
    hours = Math.min(hours, settings.get('file_retention_large_hours'))
  }
  return input.createdAt + hours * HOUR_MS
}
