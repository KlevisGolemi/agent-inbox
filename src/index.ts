import { buildRuntime } from './bootstrap.js'
import { loadEnv } from './env.js'
import { log } from './log.js'

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const runtime = await buildRuntime(env)
  const jobs = runtime.start()
  const server = runtime.app.listen(env.port, () => {
    log('info', 'Cowork Queue démarré', { port: env.port, public_url: env.publicUrl.href })
  })

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    log('info', 'Arrêt en cours', { signal })
    jobs.stop()
    server.close(() => {
      runtime.db.close()
      log('info', 'Arrêt terminé')
      process.exit(0)
    })
    // Connexions keep-alive résiduelles : on ferme sans attendre indéfiniment.
    server.closeIdleConnections()
    setTimeout(() => {
      log('warn', 'Arrêt forcé après délai')
      process.exit(1)
    }, 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  log('error', 'Démarrage impossible', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
