import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { PNG_1X1 } from './helpers/files.js'
import { call, data, mcpSetup, rpc } from './helpers/mcp.js'

describe('outils MCP des drops', () => {
  it('catalogue : 20 outils', async () => {
    const ctx = mcpSetup()
    const names = (await rpc(ctx, 'tools/list')).body.result.tools.map(
      (t: { name: string }) => t.name,
    )
    expect(names).toHaveLength(20)
    for (const n of ['inbox_upload_link', 'inbox_create_drop', 'inbox_drops', 'inbox_revoke_drop'])
      expect(names).toContain(n)
  })

  it('inbox_upload_link : URL + curl, puis curl -F dépose dans la file', async () => {
    const ctx = mcpSetup()
    const out = data(
      await call(ctx, 'inbox_upload_link', { topic: 'builds', correlation_id: 'zip-1' }),
    )
    expect(out).toMatchObject({
      ok: true,
      url: expect.stringMatching(/\/d\/[A-Za-z0-9_-]{43}$/),
      curl: expect.stringContaining('curl -F file=@'),
    })
    const res = await request(ctx.app)
      .post(new URL(out.url).pathname)
      .attach('file', PNG_1X1, 'p.png')
    expect(res.status).toBe(200)
    expect(
      data(await call(ctx, 'queue_by_id', { correlation_id: 'zip-1' })).item.attachments,
    ).toHaveLength(1)
  })

  it('inbox_upload_link : payload au-delà de json_max_kb refusé (payload_too_large), aucun lien', async () => {
    const ctx = mcpSetup()
    ctx.settings.set('json_max_kb', 16)
    const out = data(
      await call(ctx, 'inbox_upload_link', { payload: { texte: 'x'.repeat(17 * 1024) } }),
    )
    expect(out).toMatchObject({ ok: false, error: 'payload_too_large' })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM drops').get()).toEqual({ n: 0 })
    expect(data(await call(ctx, 'inbox_upload_link', { payload: { texte: 'court' } })).ok).toBe(
      true,
    )
  })

  it('inbox_upload_link : correlation_id déjà pris refusé dès la création (duplicate_correlation_id)', async () => {
    const ctx = mcpSetup()
    const sent = data(await call(ctx, 'queue_send', { payload: {}, correlation_id: 'pris-1' }))
    const out = data(await call(ctx, 'inbox_upload_link', { correlation_id: 'pris-1' }))
    expect(out).toMatchObject({
      ok: false,
      error: 'duplicate_correlation_id',
      existing_id: sent.id,
    })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM drops').get()).toEqual({ n: 0 })
  })

  it('inbox_create_drop, inbox_drops (sans jeton), inbox_revoke_drop', async () => {
    const ctx = mcpSetup()
    const created = data(
      await call(ctx, 'inbox_create_drop', { label: 'Factures fournisseurs', max_files: 5 }),
    )
    expect(created).toMatchObject({
      ok: true,
      drop: { label: 'Factures fournisseurs', max_files: 5, status: 'active' },
    })
    const listed = data(await call(ctx, 'inbox_drops', {}))
    expect(listed.drops).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(new URL(created.url).pathname.slice(3))
    expect(data(await call(ctx, 'inbox_revoke_drop', { drop_id: created.drop.id })).ok).toBe(true)
    expect(data(await call(ctx, 'inbox_drops', {})).drops).toHaveLength(0)
    expect(data(await call(ctx, 'inbox_drops', { include_expired: true })).drops[0].status).toBe(
      'revoked',
    )
    expect(data(await call(ctx, 'inbox_revoke_drop', { drop_id: created.drop.id })).error).toBe(
      'not_found',
    )
  })

  it('inbox_create_drop au-delà de drop_max_hours : out_of_bounds', async () => {
    const ctx = mcpSetup()
    expect(
      data(await call(ctx, 'inbox_create_drop', { label: 'x', expires_in_hours: 500 })),
    ).toMatchObject({ error: 'out_of_bounds', field: 'expires_in_hours' })
  })
})
