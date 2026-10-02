import { MB } from './types.js'
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/

export interface DecodedAttachment {
  filename: string
  data: Buffer
}

/** Taille décodée vérifiée contre `mcp_upload_max_mb` (spec §3), avant toute écriture disque. */
export function decodeBase64Attachments(
  list: readonly { filename: string; data_base64: string }[],
  maxMb: number,
):
  | { ok: true; files: DecodedAttachment[] }
  | {
      ok: false
      error: 'mcp_upload_disabled' | 'invalid_base64' | 'attachments_too_large'
      message: string
    } {
  if (maxMb === 0)
    return {
      ok: false,
      error: 'mcp_upload_disabled',
      message: 'L’envoi de fichiers en base64 est désactivé : utilise inbox_upload_link puis curl.',
    }
  const max = maxMb * MB
  let total = 0
  const files: DecodedAttachment[] = []
  for (const [i, a] of list.entries()) {
    const clean = a.data_base64.replace(/\s+/g, '')
    if (clean.length === 0 || clean.length % 4 !== 0 || !BASE64_REGEX.test(clean))
      return { ok: false, error: 'invalid_base64', message: `Pièce ${i + 1} : base64 invalide.` }
    total += (clean.length / 4) * 3 - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0)
    if (total > max)
      return {
        ok: false,
        error: 'attachments_too_large',
        message: `Total des pièces supérieur à ${maxMb} Mo : utilise inbox_upload_link puis curl.`,
      }
    files.push({ filename: a.filename, data: Buffer.from(clean, 'base64') })
  }
  return { ok: true, files }
}
