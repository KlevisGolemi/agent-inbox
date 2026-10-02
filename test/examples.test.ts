import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('modèle n8n « envoyer un fichier »', () => {
  it('JSON valide : POST multipart sur /webhook avec x-tags, credential Agent Inbox', () => {
    const wf = JSON.parse(readFileSync(new URL('../examples/n8n/04-envoyer-un-fichier.json', import.meta.url), 'utf8'))
    const http = wf.nodes.find((n: { type: string }) => n.type === 'n8n-nodes-base.httpRequest')
    expect(http.parameters.url).toContain('/webhook')
    expect(http.parameters.contentType).toBe('multipart-form-data')
    expect(JSON.stringify(http.parameters)).toContain('x-tags')
    expect(JSON.stringify(wf)).not.toMatch(/cowork/i)
    expect(http.credentials.httpHeaderAuth.name).toBe('Agent Inbox')
  })
})
