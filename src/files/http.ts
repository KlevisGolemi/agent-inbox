import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import type { Request, RequestHandler, Response } from 'express'
import { log } from '../log.js'
import type { AttachmentRow, AttachmentsRepo } from './attachments.js'
import type { MultipartError } from './multipart.js'
import type { FileStore } from './store.js'
import { MB, type FileCategory } from './types.js'
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

/** Durée maximale du lingering, comptée dès l'appel à `lingerAfterError`. */
export const LINGER_MS = 10_000
/** Octets de corps refusé lus et jetés au plus par connexion, puis coupure. */
export const LINGER_MAX_BYTES = 16 * MB
/** Connexions en lingering simultanées au plus (tout le processus) ; au-delà, coupure immédiate. */
export const LINGER_MAX_SOCKETS = 32

export interface LingerLimits {
  ms?: number
  maxBytes?: number
  maxSockets?: number
}

let lingering = 0
/** Nombre de connexions actuellement en lingering. */
export function lingeringCount(): number {
  return lingering
}

/**
 * Refus d'un inconnu (401, 429, jeton invalide, corps annoncé trop gros) avant la fin du corps :
 * `Connection: close`, et Node détruit le socket dès la réponse partie. Aucune ressource n'est
 * offerte pour lire le reste ; le client peut recevoir un RST, c'est assumé. Sans effet si le
 * corps a déjà été lu en entier.
 */
export function closeAfterResponse(req: Request, res: Response): void {
  if (req.complete || res.headersSent) return
  res.set('Connection', 'close')
}

/**
 * Refus d'une requête AUTHENTIFIÉE avant la fin du corps : fermeture « lingering » (nginx,
 * Apache). Node détruit le socket dès la réponse partie (`destroySoon`, connexion `close`) : les
 * octets que le client envoie encore reçoivent un RST et le client peut perdre la réponse
 * (EPIPE/ECONNRESET). Ici : `Connection: close`, puis, la réponse partie, demi-fermeture (FIN) et
 * lecture du reste du corps, jeté, jusqu'à ce que le client ferme. Bornes : `ms` dès cet appel,
 * `maxBytes` jetés, `maxSockets` connexions simultanées (au-delà : comme `closeAfterResponse`).
 * `Connection` est un en-tête hop-by-hop : derrière Traefik/Caddy, c'est la connexion
 * proxy → application qui est ainsi gérée ; le proxy relaie la réponse au client.
 */
export function lingerAfterError(req: Request, res: Response, limits: LingerLimits = {}): void {
  if (req.complete || res.headersSent) return
  const { ms = LINGER_MS, maxBytes = LINGER_MAX_BYTES, maxSockets = LINGER_MAX_SOCKETS } = limits
  res.set('Connection', 'close')
  const socket = req.socket
  // Socket déjà fermée (réponse tardive) : rien à lire, rien à compter.
  if (socket.destroyed || res.destroyed || lingering >= maxSockets) return
  lingering++
  // Exactement un décrément, quel que soit le chemin : fermeture, délai, plafond, arrêt.
  let released = false
  const release = () => {
    if (released) return
    released = true
    lingering--
    clearTimeout(timer)
  }
  const stop = () => {
    release()
    socket.destroy()
  }
  const timer = setTimeout(stop, ms)
  timer.unref()
  socket.once('close', release)
  let discarded = 0
  const discard = (chunk: Buffer) => {
    discarded += chunk.length
    if (discarded > maxBytes) stop()
  }
  req.on('data', discard)
  req.resume()
  socket.destroySoon = () => {
    socket.end()
    // Une fois la réponse finie, Node retire les écouteurs `data` (req._dump) : on remet le compteur.
    if (req.listenerCount('data') === 0) req.on('data', discard)
  }
}

export type EarlyResponsePolicy = 'close' | 'linger'
const policies = new WeakMap<Response, EarlyResponsePolicy>()

/**
 * Politique pour toute réponse envoyée avant la fin du corps, appliquée au moment où les en-têtes
 * partent : `close` par défaut (inconnu), `linger` une fois la requête authentifiée.
 */
export function setEarlyResponsePolicy(
  req: Request,
  res: Response,
  policy: EarlyResponsePolicy,
): void {
  const hooked = policies.has(res)
  policies.set(res, policy)
  if (hooked) return
  const writeHead = res.writeHead
  res.writeHead = function (this: Response, ...args: Parameters<typeof writeHead>) {
    if (policies.get(res) === 'linger') lingerAfterError(req, res)
    else closeAfterResponse(req, res)
    return writeHead.apply(this, args)
  } as typeof writeHead
}

/** Middleware : fixe la politique de réponse anticipée (voir `setEarlyResponsePolicy`). */
export function earlyResponsePolicy(policy: EarlyResponsePolicy): RequestHandler {
  return (req, res, next) => {
    setEarlyResponsePolicy(req, res, policy)
    next()
  }
}

/** Réponse d'erreur d'envoi : message sans chemin ni nom de fichier. */
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
 * Échec de lecture d'une pièce : réponse JSON si les en-têtes ne sont pas partis (en-têtes de fichier
 * retirés), sinon coupure propre de la réponse (le client voit une réponse incomplète, jamais un blocage).
 */
function failRead(res: Response, status: 410 | 500): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  for (const h of ['Content-Disposition', 'Content-Length', 'Content-Type', 'Accept-Ranges'])
    res.removeHeader(h)
  if (status === 410) res.status(410).json({ ok: false, error: 'file_gone' })
  else res.status(500).json({ ok: false, error: 'internal_error', message: 'Erreur interne.' })
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
        // Fichier absent : 410 ; autre erreur (droits, dossier, E/S) : 500 et log (id et code seuls).
        const code = (err as NodeJS.ErrnoException).code
        // Client parti en cours de route : rien à répondre ni à journaliser.
        if (code === 'ECONNABORTED' || res.destroyed) return
        if (code === 'ENOENT') {
          failRead(res, 410)
          return
        }
        log('error', 'Lecture de pièce impossible', { id: row.id, code: code ?? 'unknown' })
        failRead(res, 500)
      },
    )
    return
  }
  res.set({ 'Accept-Ranges': 'none', 'Content-Length': String(row.size_bytes) })
  if (req.method !== 'GET') {
    res.end()
    return
  }
  void streamWhole(path, row.size_bytes, res).then((delivered) => {
    if (delivered && count) deps.attachments.recordDelivery(row.id)
  })
}

/**
 * Envoie le fichier et résout `true` dès que tous ses octets ont été remis au socket (rappels de
 * `write` sans erreur), ce qu'aurait garanti `finish`. On n'attend ni la fin du flux de lecture ni
 * `finish` : avec Content-Length, le client a déjà tout et peut fermer avant que `end()` ne soit
 * appelé (la fin du fichier se lit par une lecture de plus) ; la livraison doit quand même compter.
 * Client coupé avant, fichier disparu ou erreur de lecture : `false`, rien n'est compté.
 * Au plus une fois : « remis au socket » ne prouve pas que le client a lu les octets (noyau,
 * proxy) ; la grâce du mode consume couvre ce cas.
 */
function streamWhole(path: string, size: number, res: Response): Promise<boolean> {
  return new Promise((done) => {
    let flushed = 0
    const src = createReadStream(path)
    src.on('data', (chunk: string | Buffer) => {
      const more = res.write(chunk, (err) => {
        if (err) return
        flushed += Buffer.byteLength(chunk)
        if (flushed === size) done(true)
      })
      if (!more) {
        src.pause()
        res.once('drain', () => src.resume())
      }
    })
    src.once('end', () => res.end())
    // Erreur de lecture : 410 si rien n'est encore parti, sinon coupure (réponse incomplète).
    src.once('error', () => {
      failRead(res, 410)
      done(false)
    })
    res.once('finish', () => done(flushed === size))
    res.once('close', () => {
      src.destroy()
      done(false)
    })
  })
}
