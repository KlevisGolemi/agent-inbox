export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Une ligne JSON par événement. Ne jamais y passer de secret, jeton ou payload complet. */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ...fields, ts: new Date().toISOString(), level, msg }) + '\n'
  if (level === 'error') process.stderr.write(line)
  else process.stdout.write(line)
}

/** Chemin sûr pour les logs : jamais de jeton de dépôt ni d'identifiant de fichier signé (spec §11). */
export function redactPath(path: string): string {
  return path.replace(/^\/d\/[^/]+.*$/, '/d/…').replace(/^\/files\/[^/]+.*$/, '/files/…')
}
