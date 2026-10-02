import { randomBytes } from 'node:crypto'
import { Router, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { newAttachments } from '../files/attachments.js'
import {
  attachmentSummary,
  earlyResponsePolicy,
  sendUploadError,
  setEarlyResponsePolicy,
} from '../files/http.js'
import { MultipartError, receiveUpload } from '../files/multipart.js'
import { MB, type FileCategory } from '../files/types.js'
import { UploadError, type UploadManager } from '../files/uploads.js'
import { log } from '../log.js'
import type { QueueRepo } from '../queue/repo.js'
import type { Settings } from '../settings/index.js'
import { DROP_TEXT_MAX_BYTES, dropPageCsp, renderDropPage, UNAVAILABLE_PAGE } from './page.js'
import type { DropsRepo } from './repo.js'

const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
}

export function createDropsRouter(deps: {
  drops: DropsRepo
  repo: QueueRepo
  uploads: UploadManager
  settings: Settings
}): Router {
  const { drops, repo, uploads, settings } = deps
  const router = Router()
  // Réponse avant la fin du corps : fermeture immédiate (429, jeton invalide) ; lingering borné
  // une fois le jeton reconnu.
  router.use('/d', earlyResponsePolicy('close'))
  router.use(
    '/d',
    rateLimit({
      windowMs: 60_000,
      limit: () => settings.get('drop_rate_limit_per_min'),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { ok: false, error: 'Too many requests' },
    }),
  )
  const unavailablePage = (res: Response) =>
    res
      .status(404)
      .set({ ...PAGE_HEADERS, 'Content-Security-Policy': dropPageCsp('none') })
      .type('html')
      .send(UNAVAILABLE_PAGE)
  const unavailableJson = (res: Response) =>
    res.status(404).json({ ok: false, error: 'unavailable', message: 'Lien indisponible.' })

  router.get('/d/:token', (req, res) => {
    const drop = settings.get('drops_enabled')
      ? drops.findActiveByToken(String(req.params.token))
      : null
    if (!drop || drop.kind !== 'public') {
      unavailablePage(res)
      return
    }
    const nonce = randomBytes(16).toString('base64')
    res
      .set({ ...PAGE_HEADERS, 'Content-Security-Policy': dropPageCsp(nonce) })
      .type('html')
      .send(
        renderDropPage({
          label: drop.label,
          remaining: drop.max_files - drop.files_count,
          maxFileMb: drop.max_file_mb,
          categories: JSON.parse(drop.allowed_categories) as FileCategory[],
          expiresAt: drop.expires_at,
          nonce,
        }),
      )
  })

  router.post('/d/:token', async (req, res) => {
    const drop = drops.findActiveByToken(String(req.params.token))
    if (!drop || (drop.kind === 'public' && !settings.get('drops_enabled'))) {
      unavailableJson(res)
      return
    }
    setEarlyResponsePolicy(req, res, 'linger')
    if (!req.is('multipart/form-data')) {
      res.status(415).json({
        ok: false,
        error: 'multipart_required',
        message: 'Envoyez les fichiers en multipart/form-data.',
      })
      return
    }
    // Lien self : réservé atomiquement pour CETTE requête dès le début (une seule requête).
    const claimAt = drop.kind === 'self' ? Date.now() : null
    if (claimAt !== null && !drops.claimSelf(drop.id, claimAt)) {
      unavailableJson(res)
      return
    }
    let reserved = 0
    let done = false
    /** Toute issue autre qu'un dépôt commité : places rendues, lien self restauré, trace dans drop_events. */
    const compensate = (code: string) => {
      if (done) return
      done = true
      drops.releaseSlots(drop.id, reserved)
      if (claimAt !== null) drops.releaseSelf(drop.id, claimAt)
      drops.addEvent({
        dropId: drop.id,
        outcome: `rejected:${code}`,
        files: 0,
        bytes: 0,
        messageId: null,
      })
    }
    try {
      const out = await receiveUpload(req, uploads, {
        maxFieldBytes:
          drop.kind === 'self' ? settings.get('json_max_kb') * 1024 : DROP_TEXT_MAX_BYTES,
        stage: {
          maxBytes: drop.max_file_mb * MB,
          allowedCategories: JSON.parse(drop.allowed_categories) as FileCategory[],
        },
        beforeFile: () => {
          if (!drops.reserveSlot(drop.id, claimAt))
            throw new UploadError('drop_full', 'Ce lien n’accepte plus de fichiers.')
          reserved++
        },
        prepare: (fields) => ({ ok: true, value: fields }),
        write(fields, files) {
          if (files.length === 0) throw new UploadError('no_file', 'Aucun fichier reçu.')
          const payload =
            drop.kind === 'self'
              ? (JSON.parse(drop.message_payload ?? '{}') as Record<string, unknown>)
              : {
                  ...(fields.text ? { text: fields.text } : {}),
                  drop: { id: drop.id, label: drop.label },
                }
          return repo.enqueue({
            payload,
            source: `drop:${drop.label}`,
            correlationId: drop.correlation_id,
            topic: drop.topic,
            tags: drops.tagsOf(drop.id),
            trust: drop.kind === 'public' ? 'external' : 'internal',
            dropId: drop.id,
            attachments: newAttachments(
              files,
              drop.on_download ?? settings.get('file_on_download_default'),
              settings,
              Date.now(),
            ),
          })
        },
      })
      if (out.kind === 'rejected') {
        compensate('rejected')
        res.status(out.status).json(out.body)
        return
      }
      if (!out.result.ok) {
        compensate('duplicate_correlation_id')
        res.status(409).json({
          ok: false,
          error: 'duplicate_correlation_id',
          existing_id: out.result.existingId,
        })
        return
      }
      done = true // dépôt commité : le lien self reste consommé, les places restent prises
      const files = attachmentSummary(out.files)
      const bytes = files.reduce((n, f) => n + f.size_bytes, 0)
      drops.addEvent({
        dropId: drop.id,
        outcome: 'accepted',
        files: files.length,
        bytes,
        messageId: out.result.id,
      })
      log('info', 'Dépôt reçu', {
        drop_id: drop.id,
        message_id: out.result.id,
        files: files.length,
        bytes,
      })
      res.json(
        drop.kind === 'self'
          ? { ok: true, id: out.result.id, attachments: files }
          : { ok: true, files: files.length },
      )
    } catch (err) {
      if (err instanceof UploadError || err instanceof MultipartError) {
        compensate(err.code)
        sendUploadError(res, err)
        return
      }
      compensate('internal_error')
      throw err
    }
  })
  return router
}
