// Types partagés des pièces jointes (v2.2).
import type { LogLevel } from '../log.js'

export const FILE_CATEGORIES = ['image', 'audio', 'video', 'document', 'archive', 'other'] as const
export type FileCategory = (typeof FILE_CATEGORIES)[number]
export type OnDownload = 'keep' | 'consume'
export type InlineKind = 'image' | 'audio' | 'text' | null
export type AttachmentStatus = 'available' | 'expired' | 'consumed' | 'file_gone'
export type DeletedReason = 'expired' | 'consumed' | 'message_deleted'

/** Fonction de journalisation injectable, sans donnée sensible. */
export type LogFn = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void

/** Un mébioctet en octets, partagé par les contrôles et les rétentions de fichiers. */
export const MB = 1024 * 1024
