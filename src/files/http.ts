import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import type { AttachmentRow, AttachmentsRepo } from './attachments.js'
import type { MultipartError } from './multipart.js'
import type { FileStore } from './store.js'
import type { FileCategory } from './types.js'
import type { StagedFile, UploadError } from './uploads.js'

export const FILE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Cache-Control': 'private, no-store',
}

const rfc5987 = (s: string) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

export function contentDisposition(
  filename: string,
  type: 'attachment' | 'inline' = 'attachment',
): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${type}; filename="${ascii}"; filename*=UTF-8''${rfc5987(filename)}`
}

/** Réponse d'erreur d'envoi : message sans chemin ni nom de fichier (R4 : pas de Connection: close). */
export function sendUploadError(res: Response, err: UploadError | MultipartError): void {
  if (res.headersSent || res.destroyed) return
  res.status(err.status).json({ ok: false, error: err.code, message: err.message })
}

export function attachmentSummary(files: readonly StagedFile[]): {
  id: string
  filename: string
  mime_type: string
  category: FileCategory
  size_bytes: number
}[] {
  return files.map((f) => ({
    id: f.id,
    filename: f.filename,
    mime_type: f.mime_type,
    category: f.category,
    size_bytes: f.size_bytes,
  }))
}

/**
 * Sert une pièce : `attachment` + nosniff + CSP sandbox. `keep` : Range accepté, mais seule une
 * réponse GET complète compte comme livraison. `consume` : jamais de Range.
 */
export function sendAttachment(
  req: Request,
  res: Response,
  row: AttachmentRow,
  deps: { files: FileStore; attachments: AttachmentsRepo },
  opts: { count?: boolean; disposition?: 'attachment' | 'inline' } = {},
): void {
  const count = (opts.count ?? true) && req.method === 'GET'
  res.set({
    ...FILE_SECURITY_HEADERS,
    'Content-Type': row.mime_type,
    'Content-Disposition': contentDisposition(row.filename, opts.disposition),
  })
  // res.sendFile exige un chemin absolu : la racine du stockage peut être relative (DB_PATH relatif).
  const path = resolve(deps.files.path(row.id))
  if (row.on_download === 'keep') {
    const ranged = req.headers.range !== undefined
    res.sendFile(
      path,
      {
        acceptRanges: true,
        cacheControl: false,
        etag: false,
        lastModified: false,
        dotfiles: 'allow',
      },
      (err) => {
        if (!err) {
          if (count && !ranged) deps.attachments.recordDelivery(row.id)
          return
        }
        if (!res.headersSent) res.status(410).json({ ok: false, error: 'file_gone' })
      },
    )
    return
  }
  res.set({ 'Accept-Ranges': 'none', 'Content-Length': String(row.size_bytes) })
  if (req.method !== 'GET') {
    res.end()
    return
  }
  pipeline(createReadStream(path), res).then(
    () => {
      if (count) deps.attachments.recordDelivery(row.id)
    },
    () => {
      // Client coupé ou fichier disparu : pas de livraison complète, rien n'est compté.
    },
  )
}
