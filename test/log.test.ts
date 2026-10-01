import { describe, it, expect, vi, afterEach } from 'vitest'
import { log } from '../src/log.js'

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
