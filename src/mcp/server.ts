import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Router, type RequestHandler } from 'express'
import { log } from '../log.js'
import type { QueueRepo } from '../queue/repo.js'
import type { Settings } from '../settings/index.js'
import { registerTools } from './tools.js'

export interface McpRouterDeps {
  repo: QueueRepo
  settings: Settings
  bearer: RequestHandler
  version: string
}

const methodNotAllowed: RequestHandler = (_req, res) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
}

/**
 * Serveur MCP sans état : chaque POST crée son propre serveur + transport (sans session), donc
 * rien à perdre au redémarrage. Les 401 portent WWW-Authenticate (exposé en CORS).
 */
export function createMcpRouter({ repo, settings, bearer, version }: McpRouterDeps): Router {
  const router = Router()

  // CORS écrit à la main, limité à /mcp : les clients web (claude.ai, ChatGPT) l'exigent.
  router.use('/mcp', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
    })
    if (req.method === 'OPTIONS') {
      res
        .set({
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
          'Access-Control-Max-Age': '86400',
        })
        .sendStatus(204)
      return
    }
    next()
  })

  router.post('/mcp', bearer, async (req, res) => {
    const server = new McpServer({ name: 'cowork-queue', version })
    registerTools(server, { repo, settings, version })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      log('error', 'Erreur MCP', { error: String(err) })
      if (!res.headersSent)
        res
          .status(500)
          .json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  })

  router.get('/mcp', methodNotAllowed)
  router.delete('/mcp', methodNotAllowed)
  return router
}
