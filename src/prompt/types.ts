import type { KeyEvent, RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import type { Pasted } from "./paste"

export type PromptSubmit = {
  text: string
  images: { data: string; mimeType: string }[]
}

/** What the prompt holds: its text (with "[Pasted ~N lines]" tokens), what they stand for, and attached images. */
export type PromptSnapshot = PromptSubmit & { pasted: Pasted[] }

export type SlashItem = {
  name: string
  description?: string
  run?: () => void
  /** Skills only: how to mention it mid-sentence ("/name" for Claude, "$name" for Codex). Commands only work at the start. */
  mention?: string
}

export type PromptRef = {
  text(): string
  setText(text: string): void
  clear(): void
  focus(): void
  openEditor(): Promise<void>
  isEmpty(): boolean
  /** The prompt as typed: its text still has "[Pasted ~N lines]" tokens. */
  snapshot(): PromptSnapshot
  /** Replaces the prompt (text, pasted parts and images). */
  restore(snapshot: PromptSnapshot): void
  /** Same as enter; "queue" asks the host to hold the message until the running turn ends. */
  submit(delivery?: "queue"): Promise<void>
  /** Call before the host's shortcuts; consumes the event when it returns true. */
  handleKey(key: KeyEvent): boolean
}

export type PromptProps = {
  focused: boolean
  /** The session this prompt belongs to (undefined on the home screen): each keeps its own unsent draft. */
  sessionId?: string
  cwd: string
  slashItems: SlashItem[]
  agent: { label: string; color: RGBA }
  model: { name: string; provider: string; variant?: string }
  location: string
  footerRight?: JSX.Element
  status: { running: boolean; interruptArmed: boolean }
  /** "@" completions for the typed query; omit to turn them off. */
  suggestFiles?: (query: string) => Promise<{ path: string; kind: "file" | "directory" }[]>
  /** Text is the real text (pasted parts expanded). Reject to retain the draft, including images. */
  onSubmit(input: PromptSubmit, options?: { queue?: boolean }): void | Promise<void>
  ref?: (api: PromptRef | undefined) => void
}
