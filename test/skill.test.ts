import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mcpSetup, rpc } from './helpers/mcp.js'

const DIR = new URL('../skills/agent-inbox/', import.meta.url)
const SRC = new URL('../src/', import.meta.url)

/** Tout le code source (src/**\/*.ts) concaténé : un code d'erreur documenté doit y figurer entre guillemets. */
function readSource(dir: URL): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((e) =>
      e.isDirectory()
        ? readSource(new URL(`${e.name}/`, dir))
        : e.name.endsWith('.ts')
          ? readFileSync(new URL(e.name, dir), 'utf8')
          : '',
    )
    .join('\n')
}

/** Codes de la colonne « Code » des tableaux de la section « ## Erreurs » (cellules en `code`). */
function documentedCodes(ref: string): string[] {
  const section = ref.split('## Erreurs')[1] ?? ''
  const codes: string[] = []
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const first = line.split('|')[1] ?? ''
    for (const m of first.matchAll(/`([^`]+)`/g)) codes.push(m[1]!)
  }
  return codes
}

describe('skill agent-inbox', () => {
  it('SKILL.md : front matter name/description, sans préfixe réservé', () => {
    const md = readFileSync(new URL('SKILL.md', DIR), 'utf8')
    expect(md).toMatch(/^---\nname: agent-inbox\ndescription: .{50,1024}\n---\n/)
    expect(md.toLowerCase()).not.toContain('cowork')
    expect(md.match(/^name: (.+)$/m)?.[1]).toBe(basename(DIR.pathname))
  })

  it('une référence par outil MCP, et rien d’autre', async () => {
    const tools = (await rpc(mcpSetup(), 'tools/list')).body.result.tools as {
      name: string
      inputSchema: { properties?: Record<string, unknown> }
    }[]
    const files = readdirSync(new URL('references/', DIR))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort()
    expect(files).toEqual(tools.map((t) => t.name).sort())
    for (const t of tools) {
      const ref = readFileSync(new URL(`references/${t.name}.md`, DIR), 'utf8')
      expect(ref).toMatch(new RegExp(`^# ${t.name}\\n`))
      for (const param of Object.keys(t.inputSchema.properties ?? {}))
        expect(ref).toContain(`\`${param}\``)
      expect(ref).toMatch(/## Erreurs/)
    }
  })

  it('chaque code d’erreur documenté existe dans le code source', () => {
    const source = readSource(SRC)
    for (const f of readdirSync(new URL('references/', DIR))) {
      const ref = readFileSync(new URL(`references/${f}`, DIR), 'utf8')
      for (const code of documentedCodes(ref))
        expect(source, `${f} : code « ${code} » introuvable dans src/`).toMatch(
          new RegExp(`['"]${code}['"]`),
        )
    }
  })

  it('SKILL.md renvoie vers chaque référence', () => {
    const md = readFileSync(new URL('SKILL.md', DIR), 'utf8')
    for (const f of readdirSync(new URL('references/', DIR)))
      expect(md).toContain(`references/${f}`)
    expect(existsSync(new URL('references/inbox_get_file.md', DIR))).toBe(true)
  })
})
