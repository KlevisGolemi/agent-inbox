import request from 'supertest'
import type { AppDeps } from '../../src/app.js'
import { makeTestApp } from './app.js'

export const MCP_HEADERS = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
}
/** Corps JSON-RPC non typé : les tests en inspectent des champs arbitraires. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rpc = any

/** Corps JSON-RPC d'une réponse JSON ou SSE (lignes `data:`). */
export function rpcBody(res: request.Response): Rpc {
  if (res.body && Object.keys(res.body).length > 0) return res.body
  const line = res.text.split('\n').find((l) => l.startsWith('data:'))
  return JSON.parse(line!.slice(5).trim())
}

export function mcpSetup(over: Partial<AppDeps> = {}) {
  const t = makeTestApp(over)
  const { key } = t.apiKeys.create('test')
  return { ...t, key }
}

type Ctx = { app: Parameters<typeof request>[0]; key: string }
let seq = 0
export async function rpc(ctx: Ctx, method: string, params?: unknown) {
  const res = await request(ctx.app)
    .post('/mcp')
    .set(MCP_HEADERS)
    .set('authorization', `Bearer ${ctx.key}`)
    .send({ jsonrpc: '2.0', id: ++seq, method, params })
  return { res, body: rpcBody(res) }
}
/** Appelle un outil et renvoie son résultat (`result` JSON-RPC). */
export async function call(ctx: Ctx, name: string, args: Record<string, unknown> = {}) {
  return (await rpc(ctx, 'tools/call', { name, arguments: args })).body
}
/** Données métier d'un résultat d'outil (structuredContent). */
export const data = (body: Rpc) => body.result.structuredContent
