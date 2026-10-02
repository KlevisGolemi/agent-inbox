// Types partagés des pièces jointes (v2.2).
export const FILE_CATEGORIES = ['image', 'audio', 'video', 'document', 'archive', 'other'] as const
export type FileCategory = (typeof FILE_CATEGORIES)[number]
export type OnDownload = 'keep' | 'consume'
export type InlineKind = 'image' | 'audio' | 'text' | null
export type AttachmentStatus = 'available' | 'expired' | 'consumed' | 'file_gone'
export type DeletedReason = 'expired' | 'consumed' | 'message_deleted'
