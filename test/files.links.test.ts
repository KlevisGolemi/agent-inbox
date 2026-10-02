import { describe, expect, it } from 'vitest'
import { signFileUrl, verifyFileSignature } from '../src/files/links.js'

const ID = '11111111-1111-4111-8111-111111111111'
const SECRET = 'k'.repeat(64)
const base = new URL('https://queue.example.test/')

describe('liens signés', () => {
  it('URL /files/<id>?exp&sig, vérifiable jusqu’à l’échéance', () => {
    const now = 1_700_000_000_000
    const l = signFileUrl({ publicUrl: base, id: ID, secret: SECRET, ttlMin: 60, now })
    const u = new URL(l.url)
    expect(u.pathname).toBe(`/files/${ID}`)
    expect(u.searchParams.get('exp')).toBe(String(now + 3_600_000))
    expect(l.expires_at).toBe(new Date(now + 3_600_000).toISOString())
    const sig = u.searchParams.get('sig')!
    expect(verifyFileSignature(ID, String(l.exp), sig, SECRET, now)).toBe(true)
    expect(verifyFileSignature(ID, String(l.exp), sig, SECRET, l.exp)).toBe(false) // échu
    expect(verifyFileSignature(ID, String(l.exp + 1), sig, SECRET, now)).toBe(false) // exp modifié
    expect(verifyFileSignature(ID.replace('1', '2'), String(l.exp), sig, SECRET, now)).toBe(false)
    expect(verifyFileSignature(ID, String(l.exp), sig, 'z'.repeat(64), now)).toBe(false) // rotation
    expect(verifyFileSignature(ID, String(l.exp), sig + 'x', SECRET, now)).toBe(false)
    expect(verifyFileSignature(ID, 'abc', sig, SECRET, now)).toBe(false)
  })
})
