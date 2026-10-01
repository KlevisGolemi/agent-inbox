/**
 * Serveur de développement (npm run dev:ui) : mêmes dépendances que la production
 * (src/bootstrap.ts), base SQLite dans .dev/, compte admin@example.com / dev-password-123.
 */
import { mkdirSync } from 'node:fs'
import { buildRuntime } from '../src/bootstrap.js'
import { loadEnv } from '../src/env.js'
import { log } from '../src/log.js'

// Identifiants de développement : créés au premier lancement (jamais affichés).
const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'dev-password-123'

mkdirSync('.dev', { recursive: true })
const env = loadEnv({
  PUBLIC_URL: 'http://localhost:3000',
  NODE_ENV: 'development',
  PORT: '3000',
  DB_PATH: '.dev/queue.db',
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
})

const runtime = await buildRuntime(env)
runtime.start()
runtime.app.listen(env.port, () => {
  log('info', 'Interface d’administration prête', {
    url: `http://localhost:${env.port}/admin`,
    admin_email: ADMIN_EMAIL,
  })
})
