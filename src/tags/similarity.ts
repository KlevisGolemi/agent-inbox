/** Minuscules, sans accents, espaces et soulignés → tirets (« Facture Client » → facture-client). */
export function normalizeTagName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return prev[b.length]!
}

/** Spec §7 : `s` final, inclusion (≥ 4 caractères), distance 1 (≥ 6 caractères) ; seuils sur le plus court. Pas de LLM. */
export function areSimilar(a: string, b: string): boolean {
  if (a === b) return true
  if (a.replace(/s$/, '') === b.replace(/s$/, '')) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length >= 4 && long.includes(short)) return true
  return short.length >= 6 && editDistance(a, b) === 1
}
