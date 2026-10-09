import { kvGet, kvSet } from "./config"
import type { AgentTimelineItem } from "./timeline"

type Image = { data: string; mimeType: string }
type Attachment = { mimeType: string; data?: string; name?: string }

// Paseo's timeline keeps a user message's text but not its images, so remember what this client sent:
// bytes for this run, mime types across restarts (kv.json, newest LIMIT messages).
const LIMIT = 300
const bytes = new Map<string, Image[]>()

export function rememberImages(messageId: string, images: Image[] | undefined) {
  if (!images?.length) return
  bytes.set(messageId, images)
  const saved = Object.entries(kvGet<Record<string, string[]>>("attachments", {}))
  kvSet("attachments", Object.fromEntries([...saved, [messageId, images.map((image) => image.mimeType)]].slice(-LIMIT)))
}

export function attachmentsOf(row: Extract<AgentTimelineItem, { type: "user_message" }>): Attachment[] {
  const ids = [row.clientMessageId, row.messageId].filter((id): id is string => !!id)
  const sent = ids.map((id) => bytes.get(id)).find(Boolean)
  if (sent) return sent.map((image) => ({ mimeType: image.mimeType, data: image.data }))
  const saved = kvGet<Record<string, string[]>>("attachments", {})
  return (ids.map((id) => saved[id]).find(Boolean) ?? []).map((mimeType) => ({ mimeType }))
}
