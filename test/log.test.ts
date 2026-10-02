import { describe, it, expect, vi, afterEach } from 'vitest'
import { log, redactPath } from '../src/log.js'

describe('log', () => {
  afterEach(() => vi.restoreAllMocks())

  it('les champs fournis ne peuvent pas écraser ts, level ni msg', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    log('info', 'vrai message', { ts: 'faux', level: 'error', msg: 'faux', extra: 1 })
    const entry = JSON.parse(String(out.mock.calls[0]?.[0]))
    expect(entry.msg).toBe('vrai message')
    expect(entry.level).toBe('info')
    expect(entry.ts).not.toBe('faux')
    expect(entry.extra).toBe(1)
  })

  it('écrit les erreurs sur stderr', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    log('error', 'boom')
    expect(err).toHaveBeenCalledOnce()
  })
})

describe('redactPath', () => {
  it.each([
    ['/d/abcDEF_123', '/d/…'],
    ['/files/11111111-1111-4111-8111-111111111111', '/files/…'],
    ['/next', '/next'],
    ['/drops', '/drops'],
  ])('%s → %s', (p, out) => expect(redactPath(p)).toBe(out))
})
