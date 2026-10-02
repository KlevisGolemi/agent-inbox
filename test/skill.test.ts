import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mcpSetup, rpc } from './helpers/mcp.js'

const DIR = new URL('../skills/agent-inbox/', import.meta.url)

describe('skill agent-inbox', () => {
  it('SKILL.md : front matter name/description, sans préfixe réservé', () => {
    const md = readFileSync(new URL('SKILL.md', DIR), 'utf8')
    expect(md).toMatch(/^---\nname: agent-inbox\ndescription: .{50,1024}\n---\n/)
    expect(md.toLowerCase()).not.toContain('cowork')
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

  it('SKILL.md renvoie vers chaque référence', () => {
    const md = readFileSync(new URL('SKILL.md', DIR), 'utf8')
    for (const f of readdirSync(new URL('references/', DIR)))
      expect(md).toContain(`references/${f}`)
    expect(existsSync(new URL('references/inbox_get_file.md', DIR))).toBe(true)
  })
})
