import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

/** Corps d'une méthode d'objet littéral (accolades équilibrées). */
function methodBody(signature: string): string {
  const start = html.indexOf(signature)
  expect(start).toBeGreaterThan(-1)
  const open = html.indexOf('{', start)
  let depth = 0
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}' && --depth === 0) return html.slice(open + 1, i)
  }
  throw new Error('méthode non terminée')
}

describe('interface : aucun texte externe interprété comme HTML', () => {
  it('une seule directive x-html : la coloration JSON', () => {
    expect(html.match(/x-html=/g)).toHaveLength(1)
    expect(html).toContain('x-html="syntaxHL(JSON.stringify(item.payload, null, 2))"')
  })

  it.each(['att.filename', 'tag.name', 'tag.description', 'drop.label', 'ev.outcome', 't.label'])(
    '%s est affiché par x-text',
    (expr) => {
      expect(html).toMatch(new RegExp(`x-text="[^"]*\\b${expr.replace('.', '\\.')}\\b`))
    },
  )

  it('syntaxHL échappe un payload déposé par un tiers', () => {
    const syntaxHL = new Function('json', methodBody('syntaxHL(json) {')) as (j: string) => string
    const out = syntaxHL(JSON.stringify({ text: '<img src=x onerror=alert(1)>', label: '"><script>alert(1)</script>' }, null, 2))
    expect(out).not.toMatch(/<img|<script/)
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('l’aperçu n’est demandé que pour les images non actives', () => {
    expect(html).toContain("att.category === 'image' && att.status === 'available' && att.mime_type !== 'image/svg+xml'")
  })
})
