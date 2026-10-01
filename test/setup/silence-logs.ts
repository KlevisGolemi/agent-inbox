/**
 * Sortie de tests silencieuse : les lignes JSON de `log()` (ts, level, msg) ne sont plus écrites
 * sur stdout/stderr. Les tests qui espionnent `process.stdout.write` (vi.spyOn) les reçoivent
 * toujours : l'espion remplace ce filtre, puis `restoreAllMocks` le remet en place.
 */
type Write = typeof process.stdout.write

const isLogLine = (chunk: unknown): boolean => {
  if (typeof chunk !== 'string' || !chunk.startsWith('{')) return false
  try {
    const entry = JSON.parse(chunk) as Record<string, unknown>
    return 'ts' in entry && 'level' in entry && 'msg' in entry
  } catch {
    return false
  }
}

for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write.bind(stream) as Write
  stream.write = ((chunk: unknown, ...rest: unknown[]) =>
    isLogLine(chunk) ? true : (original as (...a: unknown[]) => boolean)(chunk, ...rest)) as Write
}
