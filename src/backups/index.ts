import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Settings } from '../settings/index.js'

export interface BackupInfo {
  name: string
  size: number
  created_at: string
}

export interface Backups {
  /** Sauvegarde en ligne (cohérente), puis purge selon `backup_retention`. */
  run(): Promise<BackupInfo>
  /** Plus récente d'abord. */
  list(): BackupInfo[]
  /** Chemin du fichier si le nom est valide et le fichier existe, sinon null. */
  path(name: string): string | null
  /** Sauvegarde préalable, puis remplacement du contenu applicatif. */
  restore(name: string): Promise<void>
  /** Supprime les plus anciennes au-delà de la rétention ; renvoie le nombre supprimé. */
  prune(): number
}

export class BackupError extends Error {
  constructor(
    public code: 'invalid_name' | 'not_found' | 'incompatible_backup',
    message: string,
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

export const BACKUP_NAME_REGEX =
  /^queue-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?\.db$/

/** Enfants avant parents : ordre de suppression ; l'insertion suit l'ordre inverse. */
const TABLES = [
  'oauth_tokens',
  'oauth_codes',
  'admin_sessions',
  'api_keys',
  'oauth_clients',
  'users',
  'settings',
  'messages',
] as const

const pad = (n: number) => String(n).padStart(2, '0')

function stamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  )
}

/** Clé de tri (horodatage puis suffixe numérique) et date ISO déduites du nom. */
function parseName(name: string): { sort: string; iso: string } | null {
  const m = BACKUP_NAME_REGEX.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s, n] = m
  return {
    sort: `${y}${mo}${d}${h}${mi}${s}-${String(n ?? 1).padStart(6, '0')}`,
    iso: `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`,
  }
}

export function createBackups(deps: {
  db: Database.Database
  dir: string
  settings: Settings
  now?: () => number
}): Backups {
  const { db, dir, settings } = deps
  const now = deps.now ?? Date.now
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // `mode` ne s'applique qu'à la création : on resserre aussi un dossier préexistant.
  if (process.platform !== 'win32') chmodSync(dir, 0o700)

  function info(name: string): BackupInfo | null {
    const parsed = parseName(name)
    if (!parsed) return null
    return { name, size: statSync(join(dir, name)).size, created_at: parsed.iso }
  }

  function list(): BackupInfo[] {
    return readdirSync(dir)
      .filter((n) => BACKUP_NAME_REGEX.test(n))
      .sort((a, b) => (parseName(b)?.sort ?? '').localeCompare(parseName(a)?.sort ?? ''))
      .map((n) => info(n))
      .filter((i): i is BackupInfo => i !== null)
  }

  function prune(): number {
    const stale = list().slice(settings.get('backup_retention'))
    for (const b of stale) unlinkSync(join(dir, b.name))
    return stale.length
  }

  /**
   * Instantané synchrone et cohérent (VACUUM INTO) : aucune requête ne peut s'intercaler.
   * Le chemin ne vient que du nom généré (apostrophes échappées par précaution).
   */
  function snapshot(): BackupInfo {
    const base = `queue-${stamp(new Date(now()))}`
    let name = `${base}.db`
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${base}-${n}.db`
    db.exec(`VACUUM INTO '${join(dir, name).replaceAll("'", "''")}'`)
    prune()
    return info(name) as BackupInfo
  }

  // Les appels à run() sont sérialisés : sauvegarde manuelle et planifiée ne se chevauchent jamais.
  let chain: Promise<unknown> = Promise.resolve()
  function run(): Promise<BackupInfo> {
    const next = chain.then(snapshot)
    chain = next.catch(() => undefined)
    return next
  }

  function path(name: string): string | null {
    if (!BACKUP_NAME_REGEX.test(name)) return null
    const p = join(dir, name)
    return existsSync(p) ? p : null
  }

  function userVersionOf(file: string): number {
    const src = new Database(file, { readonly: true })
    try {
      return src.pragma('user_version', { simple: true }) as number
    } finally {
      src.close()
    }
  }

  async function restore(name: string): Promise<void> {
    if (!BACKUP_NAME_REGEX.test(name)) throw new BackupError('invalid_name', 'Nom invalide.')
    const file = path(name)
    if (!file) throw new BackupError('not_found', 'Sauvegarde introuvable.')
    if (userVersionOf(file) !== (db.pragma('user_version', { simple: true }) as number)) {
      throw new BackupError(
        'incompatible_backup',
        'Cette sauvegarde provient d’une autre version du schéma.',
      )
    }
    // Sauvegarde de sécurité puis remplacement dans le même tour : aucune écriture ne peut s'intercaler.
    snapshot()
    db.prepare('ATTACH DATABASE ? AS src').run(file)
    try {
      db.transaction(() => {
        for (const t of TABLES) db.exec(`DELETE FROM main.${t}`)
        for (const t of [...TABLES].reverse()) {
          db.exec(`INSERT INTO main.${t} SELECT * FROM src.${t}`)
        }
      })()
    } finally {
      db.exec('DETACH DATABASE src')
    }
    settings.reload()
  }

  return { run, list, path, restore, prune }
}
