import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { EXTERNAL_WARNING } from '../src/queue/http.js'
import {
  finalFiles,
  HEIC_MINI,
  HTML_PAGE,
  PDF_MINI,
  PNG_1X1,
  SVG_ACTIVE,
  TIFF_MINI,
} from './helpers/files.js'
import { call, data, mcpSetup, rpc } from './helpers/mcp.js'

const b64 = (b: Buffer) => b.toString('base64')
const D = 'Une description suffisante'

async function sendFile(
  ctx: ReturnType<typeof mcpSetup>,
  buf: Buffer,
  filename: string,
  extra: Record<string, unknown> = {},
) {
  return data(
    await call(ctx, 'queue_send', {
      payload: { a: 1 },
      attachments: [{ filename, data_base64: b64(buf) }],
      ...extra,
    }),
  )
}

describe('queue_send : pièces jointes et tags', () => {
  it('base64 PNG → pièce image enregistrée sur disque', async () => {
    const ctx = mcpSetup()
    const out = await sendFile(ctx, PNG_1X1, 'photo.png')
    expect(out).toMatchObject({
      ok: true,
      attachments: [{ filename: 'photo.png', mime_type: 'image/png', category: 'image' }],
    })
    expect(finalFiles(ctx.files.root)).toHaveLength(1)
  })

  it('total décodé > mcp_upload_max_mb : refus sans message ni fichier', async () => {
    const ctx = mcpSetup()
    ctx.settings.set('mcp_upload_max_mb', 0.0001)
    const body = await call(ctx, 'queue_send', {
      payload: {},
      attachments: [{ filename: 'a.pdf', data_base64: b64(Buffer.alloc(200, 65)) }],
    })
    expect(body.result.isError).toBe(true)
    expect(data(body)).toMatchObject({ ok: false, error: 'attachments_too_large' })
    expect(ctx.repo.stats().total).toBe(0)
    expect(finalFiles(ctx.files.root)).toEqual([])
  })

  it('mcp_upload_max_mb = 0 : désactivé, renvoie vers inbox_upload_link', async () => {
    const ctx = mcpSetup()
    ctx.settings.set('mcp_upload_max_mb', 0)
    expect(
      data(
        await call(ctx, 'queue_send', {
          payload: {},
          attachments: [{ filename: 'a.pdf', data_base64: b64(PDF_MINI) }],
        }),
      ),
    ).toMatchObject({
      error: 'mcp_upload_disabled',
      message: expect.stringContaining('inbox_upload_link'),
    })
  })

  it('base64 invalide : invalid_base64', async () => {
    const ctx = mcpSetup()
    expect(
      data(
        await call(ctx, 'queue_send', {
          payload: {},
          attachments: [{ filename: 'a', data_base64: '@@@@' }],
        }),
      ).error,
    ).toBe('invalid_base64')
  })

  it('tag inconnu refusé (similar + marche à suivre), aucun message créé ; new_tags crée et pose', async () => {
    const ctx = mcpSetup()
    ctx.tags.create({ name: 'facture', description: D, createdBy: 't' })
    const refused = data(await call(ctx, 'queue_send', { payload: {}, tags: ['factures'] }))
    expect(refused).toMatchObject({
      ok: false,
      error: 'unknown_tags',
      unknown: ['factures'],
      similar: { factures: [{ name: 'facture' }] },
    })
    expect(refused.hint).toMatch(/inbox_tags/)
    expect(ctx.repo.stats().total).toBe(0)
    const ok = data(
      await call(ctx, 'queue_send', {
        payload: {},
        tags: ['facture'],
        new_tags: [{ name: 'Urgent', description: D }],
      }),
    )
    expect(ok).toMatchObject({ ok: true, tags: ['facture', 'urgent'] })
  })
})

describe('R11 et consume', () => {
  it('tag inconnu avec pièce : aucun message, aucun fichier, aucun tag créé', async () => {
    const ctx = mcpSetup()
    const out = data(
      await call(ctx, 'queue_send', {
        payload: {},
        tags: ['nope'],
        attachments: [{ filename: 'p.png', data_base64: b64(PNG_1X1) }],
      }),
    )
    expect(out.error).toBe('unknown_tags')
    expect(ctx.repo.stats().total).toBe(0)
    expect(finalFiles(ctx.files.root)).toEqual([])
  })

  it('on_download consume : la livraison inline compte (first_downloaded_at posé)', async () => {
    const ctx = mcpSetup()
    const att = (await sendFile(ctx, PNG_1X1, 'p.png', { on_download: 'consume' })).attachments[0]
    await call(ctx, 'inbox_get_file', { attachment_id: att.id })
    expect(
      ctx.db.prepare('SELECT first_downloaded_at IS NOT NULL AS d FROM attachments').get(),
    ).toEqual({ d: 1 })
  })
})

describe('queue_tag, inbox_tags, inbox_create_tag', () => {
  it('pose, retire, refuse un message inconnu', async () => {
    const ctx = mcpSetup()
    ctx.tags.create({ name: 'devis', description: D, createdBy: 't' })
    const id = data(await call(ctx, 'queue_send', { payload: {} })).id
    expect(data(await call(ctx, 'queue_tag', { message_id: id, add: ['devis'] }))).toMatchObject({
      ok: true,
      tags: ['devis'],
    })
    expect(data(await call(ctx, 'queue_tag', { message_id: id, remove: ['devis'] })).tags).toEqual(
      [],
    )
    expect(
      data(
        await call(ctx, 'queue_tag', {
          message_id: '00000000-0000-4000-8000-000000000000',
          add: ['devis'],
        }),
      ).error,
    ).toBe('not_found')
  })

  it('inbox_create_tag : proche refusé avec similar, force crée ; inbox_tags liste', async () => {
    const ctx = mcpSetup()
    await call(ctx, 'inbox_create_tag', { name: 'facture', description: D })
    expect(
      data(await call(ctx, 'inbox_create_tag', { name: 'factures', description: D })),
    ).toMatchObject({ error: 'similar_exists', similar: [{ name: 'facture' }] })
    expect(
      data(await call(ctx, 'inbox_create_tag', { name: 'factures', description: D, force: true }))
        .ok,
    ).toBe(true)
    expect(
      data(await call(ctx, 'inbox_tags', {}))
        .tags.map((t: { name: string }) => t.name)
        .sort(),
    ).toEqual(['facture', 'factures'])
  })

  it('injection : descriptions de queue_send et queue_tag listent les tags triés par nom, à chaud', async () => {
    const ctx = mcpSetup()
    ctx.tags.create({ name: 'zeta', description: D, createdBy: 't' })
    ctx.tags.create({ name: 'alpha', description: D, createdBy: 't' })
    const desc = async (name: string) =>
      (await rpc(ctx, 'tools/list')).body.result.tools.find(
        (t: { name: string }) => t.name === name,
      ).description as string
    for (const tool of ['queue_send', 'queue_tag']) {
      const d = await desc(tool)
      expect(d.indexOf('- alpha')).toBeGreaterThan(0)
      expect(d.indexOf('- alpha')).toBeLessThan(d.indexOf('- zeta'))
    }
    ctx.settings.set('tags_injected_count', 0)
    expect(await desc('queue_send')).not.toContain('- alpha')
  })
})

describe('inbox_get_file', () => {
  it('auto, image ≤ inline_max_mb : bloc image natif, livraison comptée', async () => {
    const ctx = mcpSetup()
    const att = (await sendFile(ctx, PNG_1X1, 'p.png')).attachments[0]
    const body = await call(ctx, 'inbox_get_file', { attachment_id: att.id })
    expect(body.result.content.at(-1)).toEqual({
      type: 'image',
      data: b64(PNG_1X1),
      mimeType: 'image/png',
    })
    expect(data(body)).toMatchObject({
      ok: true,
      delivery: 'inline',
      attachment: { id: att.id, status: 'available' },
    })
    expect(ctx.db.prepare('SELECT downloads FROM attachments').get()).toEqual({ downloads: 1 })
  })

  it('HEIC et TIFF : lien en auto, jamais de bloc image (formats refusés par les clients)', async () => {
    const ctx = mcpSetup()
    for (const [buf, name] of [
      [HEIC_MINI, 'IMG_0001.heic'],
      [TIFF_MINI, 'scan.tif'],
    ] as const) {
      const att = (await sendFile(ctx, buf, name)).attachments[0]
      expect(att.category).toBe('image')
      const body = await call(ctx, 'inbox_get_file', { attachment_id: att.id })
      expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(false)
      expect(data(body)).toMatchObject({ delivery: 'link' })
    }
  })

  it('SVG (type actif) : lien en auto, lien + note en inline ; jamais de bloc image', async () => {
    const ctx = mcpSetup()
    const att = (await sendFile(ctx, SVG_ACTIVE, 'photo.png')).attachments[0]
    expect(att.category).toBe('document')
    for (const delivery of ['auto', 'inline']) {
      const body = await call(ctx, 'inbox_get_file', { attachment_id: att.id, delivery })
      expect(
        body.result.content.some(
          (c: { type: string }) => c.type === 'image' || c.type === 'resource',
        ),
      ).toBe(false)
      expect(data(body)).toMatchObject({
        delivery: 'link',
        url: expect.stringContaining(`/files/${att.id}?exp=`),
      })
    }
    expect(
      data(await call(ctx, 'inbox_get_file', { attachment_id: att.id, delivery: 'inline' })).note,
    ).toMatch(/actif/)
  })

  it('inline_max_mb = 0 : toujours un lien ; le lien se télécharge et curl est fourni', async () => {
    const ctx = mcpSetup()
    ctx.settings.set('inline_max_mb', 0)
    const att = (await sendFile(ctx, PNG_1X1, 'p.png')).attachments[0]
    const out = data(await call(ctx, 'inbox_get_file', { attachment_id: att.id }))
    expect(out).toMatchObject({ delivery: 'link', curl: `curl -fLJO '${out.url}'` })
    const u = new URL(out.url)
    expect((await request(ctx.app).get(u.pathname + u.search)).status).toBe(200)
  })

  it('texte : resource text ; PDF en inline explicite : resource blob', async () => {
    const ctx = mcpSetup()
    const md = (await sendFile(ctx, Buffer.from('# Bonjour'), 'notes.md')).attachments[0]
    expect(
      (await call(ctx, 'inbox_get_file', { attachment_id: md.id })).result.content.at(-1),
    ).toEqual({
      type: 'resource',
      resource: {
        uri: `agent-inbox://files/${md.id}`,
        mimeType: 'text/markdown',
        text: '# Bonjour',
      },
    })
    const pdf = (await sendFile(ctx, PDF_MINI, 'a.pdf')).attachments[0]
    expect(data(await call(ctx, 'inbox_get_file', { attachment_id: pdf.id })).delivery).toBe('link')
    const blob = (
      await call(ctx, 'inbox_get_file', { attachment_id: pdf.id, delivery: 'inline' })
    ).result.content.at(-1)
    expect(blob.resource).toMatchObject({ mimeType: 'application/pdf', blob: b64(PDF_MINI) })
  })

  it('HTML en pièce : jamais inline', async () => {
    const ctx = mcpSetup()
    const att = (await sendFile(ctx, HTML_PAGE, 'page.txt')).attachments[0]
    expect(
      data(await call(ctx, 'inbox_get_file', { attachment_id: att.id, delivery: 'inline' }))
        .delivery,
    ).toBe('link')
  })

  it('message externe : l’avertissement précède le bloc inline', async () => {
    const ctx = mcpSetup()
    const att = (await sendFile(ctx, PNG_1X1, 'p.png')).attachments[0]
    ctx.db.prepare("UPDATE messages SET trust = 'external'").run()
    const body = await call(ctx, 'inbox_get_file', { attachment_id: att.id })
    expect(body.result.content[0]).toEqual({ type: 'text', text: EXTERNAL_WARNING })
    expect(data(body)).toMatchObject({ trust: 'external_unverified', warning: EXTERNAL_WARNING })
  })

  it('pièce inconnue : not_found ; expirée : expired', async () => {
    const ctx = mcpSetup()
    expect(
      data(
        await call(ctx, 'inbox_get_file', {
          attachment_id: '00000000-0000-4000-8000-000000000000',
        }),
      ).error,
    ).toBe('not_found')
    const att = (await sendFile(ctx, PNG_1X1, 'p.png')).attachments[0]
    ctx.db.prepare('UPDATE attachments SET expires_at = 1').run()
    expect(data(await call(ctx, 'inbox_get_file', { attachment_id: att.id })).error).toBe('expired')
  })
})

describe('recherche et stockage', () => {
  it('queue_search : tag et has_attachments', async () => {
    const ctx = mcpSetup()
    await sendFile(ctx, PNG_1X1, 'p.png')
    await call(ctx, 'queue_send', { payload: {} })
    expect(data(await call(ctx, 'queue_search', { tag: 'type:image' })).items).toHaveLength(1)
    expect(data(await call(ctx, 'queue_search', { has_attachments: false })).items).toHaveLength(1)
  })

  it('queue_stats et queue_status exposent storage', async () => {
    const ctx = mcpSetup()
    await sendFile(ctx, PNG_1X1, 'p.png')
    for (const tool of ['queue_stats', 'queue_status']) {
      expect(data(await call(ctx, tool)).storage).toMatchObject({
        used_bytes: PNG_1X1.length,
        files_count: 1,
        accepting: true,
      })
    }
  })
})
