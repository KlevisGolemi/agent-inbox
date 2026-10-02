import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { detectFile, extensionForMime, extensionOf, sanitizeFilename } from '../src/files/detect.js'
import { HEIC_MINI, HTML_PAGE, PDF_MINI, PNG_1X1, SVG_ACTIVE, TIFF_MINI } from './helpers/files.js'

describe('detectFile', () => {
  it.each([
    [
      'PNG',
      PNG_1X1,
      'photo.png',
      { mime: 'image/png', category: 'image', inline: 'image', active: false },
    ],
    [
      'PNG nommé .pdf (signature prioritaire)',
      PNG_1X1,
      'x.pdf',
      { mime: 'image/png', category: 'image', inline: 'image', active: false },
    ],
    [
      'HEIC (image refusée inline par les clients LLM)',
      HEIC_MINI,
      'IMG_0001.heic',
      { mime: 'image/heic', category: 'image', inline: null, active: false },
    ],
    [
      'TIFF (image refusée inline par les clients LLM)',
      TIFF_MINI,
      'scan.tif',
      { mime: 'image/tiff', category: 'image', inline: null, active: false },
    ],
    [
      'PDF',
      PDF_MINI,
      'devis.pdf',
      { mime: 'application/pdf', category: 'document', inline: null, active: false },
    ],
    [
      'gzip',
      gzipSync(Buffer.from('bonjour')),
      'a.gz',
      { mime: 'application/gzip', category: 'archive', inline: null, active: false },
    ],
    [
      'SVG nommé photo.png (type actif)',
      SVG_ACTIVE,
      'photo.png',
      { mime: 'image/svg+xml', category: 'document', inline: null, active: true },
    ],
    [
      'HTML nommé notes.txt',
      HTML_PAGE,
      'notes.txt',
      { mime: 'text/html', category: 'document', inline: null, active: true },
    ],
    [
      'Markdown',
      Buffer.from('# Titre\n'),
      'notes.md',
      { mime: 'text/markdown', category: 'document', inline: 'text', active: false },
    ],
    [
      'JSON',
      Buffer.from('{"a":1}'),
      'data.json',
      { mime: 'application/json', category: 'document', inline: 'text', active: false },
    ],
    [
      'binaire sans signature nommé .jpg',
      Buffer.from([0, 159, 146, 150, 1, 2, 3]),
      'photo.jpg',
      { mime: 'application/octet-stream', category: 'other', inline: null, active: false },
    ],
    [
      'texte nommé .html sans balise',
      Buffer.from('bonjour'),
      'page.html',
      { mime: 'text/html', category: 'document', inline: null, active: true },
    ],
  ])('%s', async (_label, buffer, name, expected) => {
    expect(await detectFile(buffer, name)).toEqual(expected)
  })
})

describe('sanitizeFilename', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\x\\rapport.pdf', 'rapport.pdf'],
    ['a\u0000b\u202ec.txt', 'abc.txt'],
    ['', 'fichier'],
    [undefined, 'fichier'],
    ['..', 'fichier'],
    ['  devis final.pdf ', 'devis final.pdf'],
    ['malware.exe.', 'malware.exe'],
    ['malware.exe. . ', 'malware.exe'],
    ['...', 'fichier'],
  ])('%j → %j', (raw, expected) => {
    expect(sanitizeFilename(raw)).toBe(expected)
  })

  it('tronque à 200 points de code en gardant l’extension', () => {
    const out = sanitizeFilename('é'.repeat(300) + '.pdf')
    expect(Array.from(out)).toHaveLength(200)
    expect(out.endsWith('.pdf')).toBe(true)
  })

  it('extensionOf', () => {
    expect(extensionOf('a.TAR.GZ')).toBe('gz')
    expect(extensionOf('.bashrc')).toBe('')
    expect(extensionOf('sans')).toBe('')
  })
})

describe('detectFile : petits tampons', () => {
  it('un binaire minuscule (< DETECTION_BYTES) n’est pas classé texte', async () => {
    const result = await detectFile(
      Buffer.from([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0xff, 0xfe, 0xfd]),
      'x.bin',
    )
    expect(result.category).toBe('other')
    expect(result.inline).toBeNull()
  })
})

describe('extensionForMime', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/heic', 'heic'],
    ['application/pdf', 'pdf'],
    ['text/plain', 'txt'],
    ['text/markdown', 'md'],
    ['application/zip', 'zip'],
    ['application/octet-stream', 'bin'],
    ['application/x-inconnu', 'bin'],
  ])('%s → %s', (mime, ext) => {
    expect(extensionForMime(mime)).toBe(ext)
    expect(ext).toMatch(/^[a-z0-9]{1,16}$/)
  })
})
