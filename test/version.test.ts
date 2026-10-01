import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../src/settings/index.js'
import { compareSemver, createVersionService } from '../src/version/index.js'

type Fetch = typeof fetch

function release(
  tag: string,
  body = 'Notes de version',
  url = 'https://github.com/x/y/releases/tag/t',
) {
  return new Response(JSON.stringify({ tag_name: tag, body, html_url: url }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function setup(
  opts: { current?: string; enabled?: boolean; fetch?: Fetch; now?: () => number } = {},
) {
  const fetchMock = vi.fn<Fetch>(opts.fetch ?? (async () => release('v2.1.0')))
  const service = createVersionService({
    settings: { get: (() => opts.enabled ?? true) as Settings['get'] },
    fetch: fetchMock,
    current: opts.current ?? '2.0.0',
    repo: 'KlevisGolemi/agent-inbox',
    now: opts.now,
  })
  return { service, fetchMock }
}

describe('compareSemver', () => {
  it('compare numériquement et ignore le préfixe v', () => {
    expect(compareSemver('v2.1.0', '2.0.0')).toBeGreaterThan(0)
    expect(compareSemver('2.0.0', 'v2.0.0')).toBe(0)
    expect(compareSemver('2.10.0', '2.9.0')).toBeGreaterThan(0)
  })
  it('classe une pré-version avant la version finale', () => {
    expect(compareSemver('2.0.0-dev', '2.0.0')).toBeLessThan(0)
    expect(compareSemver('2.0.0-rc.2', '2.0.0-rc.10')).toBeLessThan(0)
    expect(compareSemver('2.0.0-alpha', '2.0.0-beta')).toBeLessThan(0)
  })
  it('renvoie null si une version est illisible', () => {
    expect(compareSemver('latest', '2.0.0')).toBeNull()
  })
})

describe('createVersionService', () => {
  it('signale une mise à jour disponible (2.0.0 → v2.1.0)', async () => {
    const { service } = setup()
    const res = await service.check()
    expect(res).toEqual({
      current: '2.0.0',
      latest: '2.1.0',
      updateAvailable: true,
      notes: 'Notes de version',
      url: 'https://github.com/x/y/releases/tag/t',
    })
  })

  it('n’en signale pas quand la version est à jour', async () => {
    const { service } = setup({ current: '2.1.0' })
    expect((await service.check()).updateAvailable).toBe(false)
  })

  it('considère 2.0.0-dev comme antérieure à v2.0.0', async () => {
    const { service } = setup({
      current: '2.0.0-dev',
      fetch: async () => release('v2.0.0'),
    })
    expect((await service.check()).updateAvailable).toBe(true)
  })

  it('interroge l’API GitHub avec les en-têtes et le délai attendus', async () => {
    const { service, fetchMock } = setup()
    await service.check()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(
      'https://api.github.com/repos/KlevisGolemi/agent-inbox/releases/latest',
    )
    const headers = new Headers(init?.headers)
    expect(headers.get('accept')).toBe('application/vnd.github+json')
    expect(headers.get('user-agent')).toBe('agent-inbox/2.0.0')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('ne lève pas sur une erreur réseau', async () => {
    const { service } = setup({
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const res = await service.check()
    expect(res).toEqual({
      current: '2.0.0',
      latest: null,
      updateAvailable: false,
      notes: null,
      url: null,
    })
  })

  it('traite une réponse HTTP non 2xx ou illisible comme une erreur réseau', async () => {
    const a = setup({ fetch: async () => new Response('nope', { status: 403 }) })
    expect((await a.service.check()).latest).toBeNull()
    const b = setup({ fetch: async () => new Response('{"tag_name":42}', { status: 200 }) })
    expect((await b.service.check()).latest).toBeNull()
  })

  it('n’appelle pas fetch quand la vérification est désactivée', async () => {
    const { service, fetchMock } = setup({ enabled: false })
    const res = await service.check()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.latest).toBeNull()
  })

  it('met en cache 6 h : un seul fetch pour deux appels rapprochés', async () => {
    let t = 1_000_000
    const { service, fetchMock } = setup({ now: () => t })
    await service.check()
    t += 5 * 3600_000
    await service.check()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    t += 2 * 3600_000
    await service.check()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('ne garde pas un échec en cache plus de quelques minutes', async () => {
    let t = 0
    let fail = true
    const { service, fetchMock } = setup({
      now: () => t,
      fetch: async () => {
        if (fail) throw new Error('down')
        return release('v2.1.0')
      },
    })
    expect((await service.check()).latest).toBeNull()
    t += 60_000
    await service.check()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fail = false
    t += 15 * 60_000
    expect((await service.check()).latest).toBe('2.1.0')
  })

  it('expose la version installée', () => {
    expect(setup().service.current).toBe('2.0.0')
  })
})
