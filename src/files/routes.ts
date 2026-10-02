import { Router, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { queryString } from '../queue/http.js'
import { checkWebhookSecret } from '../queue/secret.js'
import type { Settings } from '../settings/index.js'
import type { AttachmentsRepo } from './attachments.js'
import { sendAttachment } from './http.js'
import { verifyFileSignature } from './links.js'
import type { FileStore } from './store.js'

export const FILES_RATE_LIMIT_PER_MIN = 120

export function createFilesRouter(deps: {
  attachments: AttachmentsRepo
  files: FileStore
  settings: Settings
}): Router {
  const router = Router()
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: FILES_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests' },
  })
  const notFound = (res: Response) => res.status(404).json({ ok: false, error: 'not_found' })

  router.get('/files/:id', limiter, (req, res) => {
    const id = String(req.params.id)
    const exp = queryString(req, 'exp')
    const sig = queryString(req, 'sig')
    if (exp !== undefined || sig !== undefined) {
      // Lien signé : aucune information sur la cause du refus (expiré, falsifié, rotation).
      if (
        !verifyFileSignature(
          id,
          exp ?? '',
          sig ?? '',
          deps.settings.get('file_signing_secret'),
          Date.now(),
        )
      ) {
        notFound(res)
        return
      }
    } else if (!checkWebhookSecret(req, deps.settings)) {
      res.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }
    const row = deps.attachments.get(id)
    if (!row) {
      notFound(res)
      return
    }
    const status = deps.attachments.status(row)
    if (status !== 'available') {
      res.status(410).json({ ok: false, error: status })
      return
    }
    sendAttachment(req, res, row, deps)
  })
  return router
}
