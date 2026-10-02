import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('modèle n8n « envoyer un fichier »', () => {
  it('JSON valide : POST multipart sur /webhook avec x-tags, credential Agent Inbox', () => {
    const wf = JSON.parse(
      readFileSync(new URL('../examples/n8n/04-envoyer-un-fichier.json', import.meta.url), 'utf8'),
    )
    const http = wf.nodes.find((n: { type: string }) => n.type === 'n8n-nodes-base.httpRequest')
    expect(http.parameters.url).toContain('/webhook')
    expect(http.parameters.contentType).toBe('multipart-form-data')
    expect(JSON.stringify(http.parameters)).toContain('x-tags')
    expect(JSON.stringify(wf)).not.toMatch(/cowork/i)
    expect(http.credentials.httpHeaderAuth.name).toBe('Agent Inbox')
  })

  it('lecture par readWriteFile et identifiants de nœuds en UUID valides', () => {
    const wf = JSON.parse(
      readFileSync(new URL('../examples/n8n/04-envoyer-un-fichier.json', import.meta.url), 'utf8'),
    )
    const types = wf.nodes.map((n: { type: string }) => n.type)
    expect(types).toContain('n8n-nodes-base.readWriteFile')
    expect(types).not.toContain('n8n-nodes-base.readBinaryFile')
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    for (const n of wf.nodes as { id: string }[]) expect(n.id).toMatch(uuid)
  })
})
