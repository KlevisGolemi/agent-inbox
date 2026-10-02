import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Router, type RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import { log } from '../log.js'
import { registerTools, type McpToolDeps } from './tools.js'

export type McpRouterDeps = McpToolDeps & { bearer: RequestHandler }

/** Limite de débit de `POST /mcp` (requêtes par minute et par IP). */
export const MCP_RATE_LIMIT_PER_MIN = 600

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
export function createMcpRouter({ bearer, ...toolDeps }: McpRouterDeps): Router {
  const router = Router()
  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    limit: MCP_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests' }, id: null },
  })

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

  router.post('/mcp', mcpLimiter, bearer, async (req, res) => {
    const server = new McpServer({ name: 'agent-inbox', version: toolDeps.version })
    registerTools(server, toolDeps)
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
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
    }
  })

  router.get('/mcp', methodNotAllowed)
  router.delete('/mcp', methodNotAllowed)
  return router
}
