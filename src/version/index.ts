import type { Settings } from '../settings/index.js'

/** Dépôt GitHub dont on suit les releases (surchargeable par UPDATE_REPO). */
export const DEFAULT_UPDATE_REPO = 'KlevisGolemi/agent-inbox'

const CACHE_MS = 6 * 3600_000
/** Un échec réseau n'est retenu que brièvement, pour ne pas marteler GitHub. */
const FAILURE_CACHE_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 5_000
const MAX_NOTES_LENGTH = 4000

export interface VersionInfo {
  current: string
  latest: string | null
  updateAvailable: boolean
  notes: string | null
  url: string | null
}

export interface VersionService {
  current: string
  check(): Promise<VersionInfo>
}

export interface VersionDeps {
  settings: Pick<Settings, 'get'>
  fetch: typeof fetch
  current: string
  repo: string
  now?: () => number
}

interface Parsed {
  core: [number, number, number]
  pre: string[]
}

function parse(raw: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  }
}

function comparePre(a: string[], b: string[]): number {
  // Une version finale est supérieure à toute pré-version.
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Compare deux versions semver (préfixe `v` toléré) ; null si l'une est illisible. */
export function compareSemver(a: string, b: string): number | null {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!
    if (d !== 0) return d
  }
  return comparePre(pa.pre, pb.pre)
}

export function createVersionService(deps: VersionDeps): VersionService {
  const now = deps.now ?? Date.now
  const none: VersionInfo = {
    current: deps.current,
    latest: null,
    updateAvailable: false,
    notes: null,
    url: null,
  }
  let cached: { at: number; ttl: number; value: VersionInfo } | null = null

  async function fetchLatest(): Promise<VersionInfo | null> {
    try {
      const res = await deps.fetch(`https://api.github.com/repos/${deps.repo}/releases/latest`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `agent-inbox/${deps.current}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { tag_name?: unknown; body?: unknown; html_url?: unknown }
      if (typeof body.tag_name !== 'string' || !parse(body.tag_name)) return null
      const cmp = compareSemver(body.tag_name, deps.current)
      return {
        current: deps.current,
        latest: body.tag_name.replace(/^v/, ''),
        updateAvailable: cmp !== null && cmp > 0,
        notes: typeof body.body === 'string' ? body.body.slice(0, MAX_NOTES_LENGTH) : null,
        url: typeof body.html_url === 'string' ? body.html_url : null,
      }
    } catch {
      return null
    }
  }

  return {
    current: deps.current,
    async check() {
      if (!deps.settings.get('update_check_enabled')) return none
      if (cached && now() - cached.at < cached.ttl) return cached.value
      const value = await fetchLatest()
      cached = { at: now(), ttl: value ? CACHE_MS : FAILURE_CACHE_MS, value: value ?? none }
      return cached.value
    },
  }
}
