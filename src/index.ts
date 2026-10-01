import { buildRuntime } from './bootstrap.js'
import { loadEnv } from './env.js'
import { log } from './log.js'
import { createShutdown } from './shutdown.js'

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const runtime = await buildRuntime(env)
  const jobs = runtime.start()
  const server = runtime.app.listen(env.port, () => {
    log('info', 'Agent Inbox démarré', { port: env.port, public_url: env.publicUrl.href })
  })

  const shutdown = createShutdown({
    server,
    runtime,
    jobs,
    exit: (code) => process.exit(code),
    log,
  })
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  log('error', 'Démarrage impossible', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
