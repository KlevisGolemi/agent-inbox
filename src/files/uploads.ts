import { createHash } from 'node:crypto'
import { createWriteStream, statfsSync } from 'node:fs'
import { finished as streamFinished } from 'node:stream/promises'
import { log as defaultLog } from '../log.js'
import type { Settings } from '../settings/index.js'
import { DETECTION_BYTES, detectFile, extensionOf, sanitizeFilename, type Detected } from './detect.js'
import type { FileStore } from './store.js'
import { MB, type FileCategory, type InlineKind, type LogFn } from './types.js'

const GB = 1024 ** 3

export type UploadErrorCode =
  | 'attachments_disabled'
  | 'too_many_files'
  | 'file_too_large'
  | 'empty_file'
  | 'no_file'
  | 'category_not_allowed'
  | 'extension_blocked'
  | 'quota_exceeded'
  | 'disk_full'
  | 'drop_full'
  | 'aborted'
  | 'shutting_down'

export const UPLOAD_ERROR_STATUS: Record<UploadErrorCode, number> = {
  attachments_disabled: 403,
  too_many_files: 413,
  file_too_large: 413,
  empty_file: 400,
  no_file: 400,
  category_not_allowed: 415,
  extension_blocked: 415,
  quota_exceeded: 507,
  disk_full: 507,
  drop_full: 413,
  aborted: 503,
  shutting_down: 503,
}

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'UploadError'
  }

  get status(): number {
    return UPLOAD_ERROR_STATUS[this.code]
  }
}

export interface StagedFile {
  id: string
  filename: string
  mime_type: string
  category: FileCategory
  inline: InlineKind
  size_bytes: number
  sha256: string
}

export interface StageOptions {
  /** Plafond supplémentaire (ex. max_file_mb d'un drop), en octets. */
  maxBytes?: number
  /** Restreint les catégories autorisées par les réglages (ex. allowed_categories d'un drop). */
  allowedCategories?: readonly FileCategory[]
}

/** Orchestration commune aux entrées multipart, MCP et drops : commencer, écrire, valider puis commit/abort. */
export interface UploadSession {
  readonly signal: AbortSignal
  readonly staged: readonly StagedFile[]
  stage(
    source: AsyncIterable<Buffer | Uint8Array | string>,
    rawFilename: string | undefined,
    opts?: StageOptions,
  ): Promise<StagedFile>
  /** Synchrone : renomme toutes les parties puis appelle `write` (une transaction) ; efface tout si échec. */
  commit<R extends { ok: boolean }>(write: (files: readonly StagedFile[]) => R): R
  abort(): Promise<void>
}

export interface StorageSnapshot {
  used_bytes: number
  reserved_bytes: number
  quota_bytes: number
  disk_free_bytes: number
  min_free_bytes: number
  files_count: number
  accepting: boolean
}

export type StatFs = (path: string) => { bavail: number | bigint; bsize: number | bigint }

export interface UploadManager {
  begin(opts?: { signal?: AbortSignal }): UploadSession
  reservedBytes(): number
  activeTempIds(): Set<string>
  snapshot(): StorageSnapshot
  shutdown(): Promise<void>
}

type DestroyableSource = AsyncIterable<Buffer | Uint8Array | string> & {
  destroy?: (error?: Error) => void
  on?: (event: 'error', listener: (error: Error) => void) => unknown
}

/** Erreur d'écriture disque sans chemin ni nom de fichier : seul le code ENOSPC/EDQUOT est exposé. */
function diskError(error: Error): Error {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new UploadError('disk_full', 'Espace disque insuffisant sur le serveur.')
  }
  return new Error('Erreur d’écriture sur le disque du serveur.')
}

const aborted = () => new UploadError('aborted', 'Envoi interrompu.')
const ignoreStreamError = () => undefined

export function createUploadManager(deps: {
  store: FileStore
  settings: Settings
  statfs?: StatFs
  log?: LogFn
}): UploadManager {
  const { store, settings } = deps
  const statfs: StatFs = deps.statfs ?? ((path) => statfsSync(path))
  const log = deps.log ?? defaultLog
  let reserved = 0
  let used = 0
  let closed = false
  const sessions = new Set<UploadSession>()
  const activeTemps = new Set<string>()

  const quotaBytes = () => Math.floor(settings.get('storage_quota_gb') * GB)
  const minFreeBytes = () => Math.floor(settings.get('storage_min_free_gb') * GB)
  const diskFreeBytes = () => {
    const stats = statfs(store.root)
    return Number(stats.bavail) * Number(stats.bsize)
  }

  function begin(opts: { signal?: AbortSignal } = {}): UploadSession {
    if (closed) throw new UploadError('shutting_down', 'Le serveur s’arrête : réessayez dans un instant.')
    if (!settings.get('attachments_enabled')) {
      throw new UploadError('attachments_disabled', 'Les pièces jointes sont désactivées sur ce serveur.')
    }

    // Une lecture SQL au début seulement ; les commits suivants sont suivis en mémoire.
    used = store.usedBytes()
    const ctrl = new AbortController()
    const staged: StagedFile[] = []
    const temps: string[] = []
    let held = 0
    let finished = false
    let abortPromise: Promise<void> | null = null
    let current: { source: DestroyableSource; settled: Promise<unknown> } | null = null
    let diskFree = 0
    let bytesSinceStatfs = MB
    const onOuterAbort = () => void session.abort()
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

    function finish(): void {
      if (finished) return
      finished = true
      reserved -= held
      held = 0
      for (const id of temps) activeTemps.delete(id)
      opts.signal?.removeEventListener('abort', onOuterAbort)
      sessions.delete(session)
    }

    /** Vérifie puis réserve ; statfs est lu au premier bloc, puis au plus une fois par mébioctet. */
    function reserve(bytes: number): void {
      if (used + reserved + bytes > quotaBytes()) {
        throw new UploadError('quota_exceeded', 'Quota de stockage des fichiers atteint.')
      }
      if (bytesSinceStatfs + bytes >= MB) {
        diskFree = diskFreeBytes()
        bytesSinceStatfs = 0
      }
      if (diskFree - bytesSinceStatfs - bytes < minFreeBytes()) {
        throw new UploadError('disk_full', 'Espace disque insuffisant sur le serveur.')
      }
      bytesSinceStatfs += bytes
      reserved += bytes
      held += bytes
    }

    /**
     * Ne rejette jamais : une écriture encore en vol au moment de notre destroy() se termine en
     * ERR_STREAM_DESTROYED (émis en 'error' avant 'close'). `events.once` rejetterait alors et
     * masquerait l'erreur métier à l'origine de l'abandon. L'écouteur 'error' permanent absorbe l'erreur.
     */
    async function destroyOutput(out: ReturnType<typeof createWriteStream>): Promise<void> {
      if (out.closed) return
      const close = new Promise<void>((resolve) => out.once('close', () => resolve()))
      out.destroy()
      await close
    }

    async function stageImpl(
      source: AsyncIterable<Buffer | Uint8Array | string>,
      rawFilename: string | undefined,
      sopts: StageOptions,
    ): Promise<StagedFile> {
      const maxCount = settings.get('attachments_max_per_message')
      if (staged.length >= maxCount) {
        throw new UploadError('too_many_files', `${maxCount} fichiers au maximum par message.`)
      }
      const filename = sanitizeFilename(rawFilename)
      const ext = extensionOf(filename)
      if (ext !== '' && settings.get('file_blocked_extensions').includes(ext)) {
        throw new UploadError('extension_blocked', `Extension « .${ext} » refusée sur ce serveur.`)
      }
      const allowed = settings
        .get('file_allowed_categories')
        .filter((category) => sopts.allowedCategories?.includes(category) ?? true)
      if (allowed.length === 0) {
        throw new UploadError('category_not_allowed', 'Aucune catégorie de fichier n’est acceptée ici.')
      }
      const maxMb = settings.get('file_max_mb')
      const capFor = (categories: readonly FileCategory[]) =>
        Math.min(sopts.maxBytes ?? Number.POSITIVE_INFINITY, Math.max(...categories.map((category) => maxMb[category])) * MB)
      let limit = capFor(allowed)
      const tooLarge = () =>
        new UploadError('file_too_large', `Fichier trop volumineux (maximum ${Math.floor(limit / MB)} Mo).`)

      const id = store.newTempId()
      temps.push(id)
      activeTemps.add(id)
      const out = createWriteStream(store.tempPath(id), { flags: 'wx', mode: 0o600 })
      let outputError: Error | null = null
      // Tout flux créé a un écouteur : aucune erreur tardive ne remonte sans preneur.
      out.on('error', (error) => {
        outputError = error
      })
      // Attend 'drain' sans jamais se bloquer si le flux est déjà (ou devient) en erreur ou fermé.
      const drained = () =>
        new Promise<void>((resolve, reject) => {
          if (outputError) return reject(outputError)
          if (out.destroyed) return reject(new Error('Flux de sortie fermé'))
          const settle = (done: () => void) => {
            out.off('drain', onDrain)
            out.off('error', onClose)
            out.off('close', onClose)
            done()
          }
          const onDrain = () => settle(resolve)
          const onClose = () => settle(() => reject(outputError ?? new Error('Flux de sortie fermé')))
          out.on('drain', onDrain)
          out.on('error', onClose)
          out.on('close', onClose)
        })
      const hash = createHash('sha256')
      const head: Buffer[] = []
      let headLen = 0
      let size = 0
      let detected: Detected | null = null
      const detect = async () => {
        const result = await detectFile(Buffer.concat(head), filename)
        detected = result
        if (!allowed.includes(result.category)) {
          throw new UploadError('category_not_allowed', `Catégorie « ${result.category} » non acceptée ici.`)
        }
        limit = capFor([result.category])
        if (size > limit) throw tooLarge()
      }

      try {
        for await (const raw of source) {
          if (ctrl.signal.aborted) throw aborted()
          const chunk =
            typeof raw === 'string'
              ? Buffer.from(raw)
              : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          if (size + chunk.length > limit) throw tooLarge()
          reserve(chunk.length)
          size += chunk.length
          hash.update(chunk)
          if (detected === null && headLen < DETECTION_BYTES) {
            const part = chunk.subarray(0, DETECTION_BYTES - headLen)
            head.push(part)
            headLen += part.length
            if (headLen >= DETECTION_BYTES) await detect()
          }
          if (outputError) throw outputError
          if (!out.write(chunk)) await drained()
          if (outputError) throw outputError
        }
        if (ctrl.signal.aborted) throw aborted()
        if (size === 0) throw new UploadError('empty_file', 'Fichier vide.')
        if (detected === null) await detect()
        // `detect` est asynchrone : le flux a pu tomber en erreur entre-temps (finish n'arriverait jamais).
        if (outputError) throw outputError
        out.end()
        await streamFinished(out)
        if (outputError) throw outputError
      } catch (error) {
        // Erreur disque relevée AVANT notre destroy() : celle qu'il provoque n'est qu'une conséquence.
        const writeError: Error | null = outputError
        // R3 : le descripteur est fermé avant de retirer son temporaire.
        await destroyOutput(out)
        if (error instanceof UploadError) throw error
        if (ctrl.signal.aborted) throw aborted()
        if (writeError) throw diskError(writeError)
        throw error
      }

      // L'affectation arrive dans `detect`, une fermeture asynchrone que TypeScript ne suit pas.
      const result = detected as Detected | null
      if (!result) throw new Error('Détection absente')
      const file: StagedFile = {
        id,
        filename,
        mime_type: result.mime,
        category: result.category,
        inline: result.inline,
        size_bytes: size,
        sha256: hash.digest('hex'),
      }
      staged.push(file)
      return file
    }

    const session: UploadSession = {
      signal: ctrl.signal,
      get staged() {
        return staged
      },
      stage(source, rawFilename, sopts = {}) {
        if (finished || ctrl.signal.aborted) return Promise.reject(aborted())
        const destroyable = source as DestroyableSource
        // Les Readable Node émettent encore parfois une erreur après destroy().
        destroyable.on?.('error', ignoreStreamError)
        const pending = stageImpl(source, rawFilename, sopts)
        current = { source: destroyable, settled: pending.catch(() => undefined) }
        return pending.catch(async (error: unknown) => {
          await session.abort()
          throw error
        })
      },
      commit(write) {
        if (finished || ctrl.signal.aborted) throw aborted()
        const ids = staged.map((file) => file.id)
        try {
          store.unlinkTemp(temps.filter((id) => !ids.includes(id)))
          store.promote(ids)
          const result = write(staged)
          if (!result.ok) store.unlinkFinal(ids)
          else {
            used += staged.reduce((total, file) => total + file.size_bytes, 0)
          }
          finish()
          return result
        } catch (error) {
          store.unlinkFinal(ids)
          store.unlinkTemp(temps)
          finish()
          throw error
        }
      },
      async abort() {
        if (abortPromise) return abortPromise
        abortPromise = (async () => {
          if (finished) return
          ctrl.abort()
          if (current?.source.destroy) {
            // R2 : attacher avant destroy évite toute erreur non gérée d'un flux source.
            current.source.on?.('error', ignoreStreamError)
            current.source.destroy(aborted())
          }
          await current?.settled
          store.unlinkTemp(temps)
          finish()
        })()
        return abortPromise
      },
    }
    sessions.add(session)
    return session
  }

  return {
    begin,
    reservedBytes: () => reserved,
    activeTempIds: () => new Set(activeTemps),
    snapshot() {
      // Lecture rare : relue en base pour rester juste (démarrage, nettoyage de rétention).
      const usedNow = store.usedBytes()
      const filesNow = store.liveCount()
      const quota = quotaBytes()
      const free = diskFreeBytes()
      const minFree = minFreeBytes()
      return {
        used_bytes: usedNow,
        reserved_bytes: reserved,
        quota_bytes: quota,
        disk_free_bytes: free,
        min_free_bytes: minFree,
        files_count: filesNow,
        accepting: !closed && settings.get('attachments_enabled') && usedNow + reserved < quota && free > minFree,
      }
    },
    async shutdown() {
      closed = true
      const count = sessions.size
      await Promise.all([...sessions].map((session) => session.abort()))
      if (count > 0) log('info', 'Uploads interrompus à l’arrêt', { count })
    },
  }
}
