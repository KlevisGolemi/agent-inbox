import { basename } from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import type { FileCategory, InlineKind } from './types.js'

/** Octets lus pour la détection (valeur recommandée par file-type). */
export const DETECTION_BYTES = 4100
export const MAX_FILENAME_LENGTH = 200

export interface Detected {
  mime: string
  category: FileCategory
  inline: InlineKind
  /** Type actif (SVG, HTML, XML, script) : jamais inline, toujours en pièce jointe. */
  active: boolean
}

const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-7z-compressed',
])
const OFFICE_PREFIXES = [
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.oasis.opendocument.',
  'application/vnd.ms-',
  'application/msword',
  'application/rtf',
]
const ACTIVE_MIMES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
])
const ACTIVE_EXTENSIONS = new Set(['svg', 'svgz', 'html', 'htm', 'xhtml', 'xml', 'xsl', 'js', 'mjs'])
const INLINE_TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json'])
/** Repli sur l'extension pour du texte seulement : une image, un son ou une vidéo exigent une signature. */
const TEXT_EXT_MIMES: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  js: 'text/javascript',
  mjs: 'text/javascript',
}
const ACTIVE_MARKERS = /^\s*(<\?xml|<!doctype\s+html|<html|<svg|<script|<head|<body|<iframe)/i

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i > 0 ? filename.slice(i + 1).toLowerCase() : ''
}

function forbiddenFilenameCodePoint(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/** Nom d'affichage sûr ; le chemin disque n'en dépend jamais. */
export function sanitizeFilename(raw: string | undefined): string {
  const base = basename(String(raw ?? '').replaceAll('\\', '/'))
  const clean = Array.from(base)
    .filter((char) => !forbiddenFilenameCodePoint(char.codePointAt(0) ?? 0))
    .join('')
    .trim()
  const safe = clean === '' || clean === '.' || clean === '..' ? 'fichier' : clean
  const points = Array.from(safe)
  if (points.length <= MAX_FILENAME_LENGTH) return safe
  const ext = extensionOf(safe)
  const suffix = ext !== '' && Array.from(ext).length <= 16 ? `.${ext}` : ''
  return points.slice(0, MAX_FILENAME_LENGTH - Array.from(suffix).length).join('') + suffix
}

export function isActiveMime(mime: string): boolean {
  return ACTIVE_MIMES.has(mime)
}

function categoryOf(mime: string): FileCategory {
  if (ACTIVE_MIMES.has(mime)) return 'document'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (ARCHIVE_MIMES.has(mime)) return 'archive'
  if (
    mime === 'application/pdf' ||
    mime === 'application/json' ||
    mime.startsWith('text/') ||
    OFFICE_PREFIXES.some((prefix) => mime.startsWith(prefix))
  )
    return 'document'
  return 'other'
}

export function inlineKindFor(mime: string, category: FileCategory): InlineKind {
  if (ACTIVE_MIMES.has(mime)) return null
  if (category === 'image') return 'image'
  if (category === 'audio') return 'audio'
  return INLINE_TEXT_MIMES.has(mime) ? 'text' : null
}

function looksLikeText(head: Uint8Array): boolean {
  // Un échantillon tronqué peut couper un caractère UTF-8 : on ignore alors les 3 derniers octets.
  const sample = head.length >= DETECTION_BYTES ? head.subarray(0, head.length - 3) : head
  if (sample.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return true
  } catch {
    return false
  }
}

/** Signature binaire d'abord, puis texte (balises actives détectées), jamais le MIME déclaré seul. */
export async function detectFile(head: Uint8Array, filename: string): Promise<Detected> {
  const ext = extensionOf(filename)
  const sniffed = await fileTypeFromBuffer(head)
  let mime: string
  if (sniffed) {
    mime = sniffed.mime
  } else if (looksLikeText(head)) {
    const text = new TextDecoder().decode(head.subarray(0, 1024))
    if (ACTIVE_MARKERS.test(text)) mime = /<svg/i.test(text) ? 'image/svg+xml' : 'text/html'
    else mime = TEXT_EXT_MIMES[ext] ?? 'text/plain'
  } else {
    mime = 'application/octet-stream'
  }
  const active = ACTIVE_MIMES.has(mime) || ACTIVE_EXTENSIONS.has(ext)
  if (active && !ACTIVE_MIMES.has(mime)) mime = TEXT_EXT_MIMES[ext] ?? 'text/html'
  const category = active ? 'document' : categoryOf(mime)
  return { mime, category, inline: active ? null : inlineKindFor(mime, category), active }
}
