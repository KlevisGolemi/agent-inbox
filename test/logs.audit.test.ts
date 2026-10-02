import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDF_MINI, PNG_1X1 } from './helpers/files.js'
import { call, data, mcpSetup } from './helpers/mcp.js'

const SECRET = 's'.repeat(40)
const H = { 'x-webhook-secret': SECRET }
afterEach(() => vi.restoreAllMocks())

describe('logs : aucune donnée sensible des fichiers et des drops', () => {
  it('ni nom de fichier, ni jeton, ni signature, ni chemin /d ou /files', async () => {
    const lines: string[] = []
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
        lines.push(String(chunk))
        return true
      })
    }
    const t = mcpSetup()
    t.settings.set('webhook_secret', SECRET)
    const NAME = 'nom-client-confidentiel.pdf'
    const id = (await request(t.app).post('/webhook').set(H).attach('file', PDF_MINI, NAME)).body.attachments[0].id
    const link = data(await call(t, 'inbox_get_file', { attachment_id: id, delivery: 'link' }))
    const u = new URL(link.url)
    await request(t.app).get(u.pathname + u.search)
    await request(t.app).get(`${u.pathname}?exp=1&sig=faux`)
    const drop = data(await call(t, 'inbox_create_drop', { label: 'Libellé confidentiel' }))
    const token = new URL(drop.url).pathname.slice(3)
    await request(t.app).get(`/d/${token}`)
    await request(t.app).post(`/d/${token}`).attach('file', PNG_1X1, 'photo-privee.png')
    await request(t.app).post(`/d/${'A'.repeat(43)}`).attach('file', PNG_1X1, 'x.png')
    const all = lines.join('')
    expect(all).toContain('Dépôt reçu') // les logs sont bien capturés
    for (const needle of [NAME, 'photo-privee', token, u.searchParams.get('sig')!, `/files/${id}`, 'Libellé confidentiel'])
      expect(all).not.toContain(needle)
  })
})
