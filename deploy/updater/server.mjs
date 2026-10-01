// Sidecar de mise à jour : un seul endpoint, POST /update, protégé par un secret partagé.
// Lance `docker compose pull app` puis `docker compose up -d app` dans /project.
// Aucune dépendance : Node seul.
import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/** Durée maximale d'une mise à jour : au-delà, le processus docker est tué. */
export const UPDATE_TIMEOUT_MS = 10 * 60_000

const defaultLog = (level, msg, fields = {}) => {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n',
  )
}

/** Comparaison en temps constant (condensés de taille fixe, quelle que soit l'entrée). */
function secretMatches(given, expected) {
  const a = createHash('sha256')
    .update(String(given ?? ''))
    .digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function sh(args, env, signal) {
  return new Promise((resolve, reject) => {
    // Sans shell : les arguments ne sont jamais interprétés. `signal` annulé → processus tué.
    const child = spawn('docker', args, {
      cwd: '/project',
      env,
      stdio: 'inherit',
      signal,
      killSignal: 'SIGKILL',
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`docker ${args.join(' ')} : code ${code}`)),
    )
  })
}

/** Environnement minimal pour docker : jamais UPDATER_SECRET ni le reste de process.env. */
export function dockerEnv(source = process.env) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE']) {
    if (source[key]) env[key] = source[key]
  }
  return env
}

/** Exécution réelle : pull puis up -d, projet Compose repris de l'environnement. */
export async function runCompose(env = dockerEnv(), signal = undefined) {
  await sh(['compose', 'pull', 'app'], env, signal)
  await sh(['compose', 'up', '-d', 'app'], env, signal)
}

export function createUpdaterServer({
  secret,
  run,
  log = defaultLog,
  timeoutMs = UPDATE_TIMEOUT_MS,
}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Updater : le secret doit être une chaîne d’au moins 32 caractères')
  }
  let running = false
  // Génération de l'exécution en cours : une exécution abandonnée (délai dépassé) qui se termine
  // plus tard ne libère pas le verrou d'une exécution plus récente.
  let generation = 0

  async function execute() {
    const current = ++generation
    const startedAt = Date.now()
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
      log('error', 'Mise à jour interrompue : délai dépassé', {
        duration_ms: Date.now() - startedAt,
        timeout_ms: timeoutMs,
      })
      if (generation === current) running = false
    }, timeoutMs)
    log('info', 'Mise à jour démarrée')
    try {
      await run(ctrl.signal)
      if (!timedOut) log('info', 'Mise à jour terminée', { duration_ms: Date.now() - startedAt })
    } catch (err) {
      if (!timedOut) {
        log('error', 'Mise à jour en échec', {
          duration_ms: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      clearTimeout(timer)
      if (generation === current) running = false
    }
  }

  return createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/update') return send(404, { ok: false, error: 'not_found' })
    if (req.method !== 'POST') return send(405, { ok: false, error: 'method_not_allowed' })
    if (!secretMatches(req.headers['x-updater-secret'], secret)) {
      return send(401, { ok: false, error: 'unauthorized' })
    }
    if (running) return send(409, { ok: false, error: 'already_running' })
    running = true
    void execute()
    send(202, { ok: true, started: true })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.UPDATER_SECRET ?? ''
  if (secret.length < 32) {
    defaultLog('error', 'UPDATER_SECRET manquant ou trop court (32 caractères minimum)')
    process.exit(1)
  }
  const port = Number(process.env.PORT || 8081)
  createUpdaterServer({ secret, run: (signal) => runCompose(dockerEnv(), signal) }).listen(
    port,
    '0.0.0.0',
    () => defaultLog('info', 'Updater prêt', { port }),
  )
}
