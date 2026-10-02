import busboy from 'busboy'
import type { Request } from 'express'
import {
  UploadError,
  type StagedFile,
  type StageOptions,
  type UploadManager,
  type UploadSession,
} from './uploads.js'

export class MultipartError extends Error {
  constructor(
    readonly code: 'field_too_large' | 'invalid_multipart',
    message: string,
  ) {
    super(message)
    this.name = 'MultipartError'
  }
  get status(): number {
    return this.code === 'field_too_large' ? 413 : 400
  }
}

export interface MultipartOptions {
  maxFieldBytes: number
  maxFields?: number
  stage?: StageOptions
  /** Appelé avant chaque fichier ; peut lever (ex. place de drop refusée). */
  beforeFile?: () => void
}
export interface MultipartResult {
  fields: Record<string, string>
  files: StagedFile[]
}

/**
 * Lit un corps multipart en flux : chaque fichier est confié, l'un après l'autre, à la session
 * (écriture en `.tmp`). Rejette à la première erreur ; l'appelant doit alors `session.abort()`.
 */
export function receiveMultipart(
  req: Request,
  session: UploadSession,
  opts: MultipartOptions,
): Promise<MultipartResult> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy
    try {
      bb = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { fieldSize: opts.maxFieldBytes, fields: opts.maxFields ?? 20 },
      })
    } catch {
      req.resume()
      reject(new MultipartError('invalid_multipart', 'Corps multipart invalide.'))
      return
    }
    const fields: Record<string, string> = {}
    let chain: Promise<void> = Promise.resolve()
    let failed = false
    const fail = (err: unknown) => {
      if (failed) return
      failed = true
      req.unpipe(bb)
      req.resume() // vide le reste du corps : la réponse d'erreur part sans EPIPE côté client
      reject(err)
    }
    bb.on('field', (name, value, info) => {
      if (info.valueTruncated)
        fail(new MultipartError('field_too_large', `Champ « ${name} » trop long.`))
      else fields[name] = value
    })
    bb.on('fieldsLimit', () => fail(new MultipartError('invalid_multipart', 'Trop de champs.')))
    bb.on('file', (_name, stream, info) => {
      chain = chain
        .then(async () => {
          if (failed) {
            stream.resume()
            return
          }
          opts.beforeFile?.()
          await session.stage(stream, info.filename, opts.stage)
        })
        .catch((err: unknown) => {
          stream.resume()
          fail(err)
        })
    })
    bb.on('close', () => {
      void chain.then(() => {
        if (!failed) resolve({ fields, files: [...session.staged] })
      })
    })
    bb.on('error', () => fail(new MultipartError('invalid_multipart', 'Corps multipart invalide.')))
    req.on('close', () => {
      if (!req.complete) fail(new UploadError('aborted', 'Envoi interrompu.'))
    })
    req.pipe(bb)
  })
}

/** Refus décidé par l'appelant après lecture des champs (ex. JSON invalide) : réponse, sans résidu. */
export interface UploadRejection {
  ok: false
  status: number
  body: Record<string, unknown>
}

export type UploadOutcome<R> =
  | { kind: 'rejected'; status: number; body: Record<string, unknown> }
  | { kind: 'committed'; result: R; files: readonly StagedFile[]; fields: Record<string, string> }

/**
 * Orchestration complète d'un envoi multipart, partagée par `/webhook` et les drops :
 * `begin` → lecture en flux (`stage` par fichier) → `prepare(fields)` (validation, peut refuser) →
 * `commit(write)` (une transaction). Toute erreur ou refus : `abort()` (aucun résidu) avant de
 * relancer l'erreur (`UploadError`/`MultipartError` à traduire par `sendUploadError`).
 * Si `result.ok` est faux, `commit` a déjà effacé les fichiers.
 */
export async function receiveUpload<P, R extends { ok: boolean }>(
  req: Request,
  uploads: UploadManager,
  opts: MultipartOptions & {
    prepare(fields: Record<string, string>): { ok: true; value: P } | UploadRejection
    write(prepared: P, files: readonly StagedFile[]): R
  },
): Promise<UploadOutcome<R>> {
  let session: UploadSession
  try {
    session = uploads.begin()
  } catch (err) {
    req.resume() // refus avant lecture : on vide le corps pour que la réponse parte proprement
    throw err
  }
  try {
    const { fields } = await receiveMultipart(req, session, opts)
    const prepared = opts.prepare(fields)
    if (!prepared.ok) {
      await session.abort()
      return { kind: 'rejected', status: prepared.status, body: prepared.body }
    }
    const result = session.commit((files) => opts.write(prepared.value, files))
    return { kind: 'committed', result, files: session.staged, fields }
  } catch (err) {
    await session.abort()
    throw err
  }
}
