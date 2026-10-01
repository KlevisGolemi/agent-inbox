export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Une ligne JSON par événement. Ne jamais y passer de secret, jeton ou payload complet. */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n'
  if (level === 'error') process.stderr.write(line)
  else process.stdout.write(line)
}
