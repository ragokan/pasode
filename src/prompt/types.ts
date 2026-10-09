import type { KeyEvent, RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"

export type PromptSubmit = {
  text: string
  images: { data: string; mimeType: string }[]
}

export type SlashItem = { name: string; description?: string; run?: () => void }

export type PromptRef = {
  text(): string
  setText(text: string): void
  clear(): void
  focus(): void
  openEditor(): Promise<void>
  isEmpty(): boolean
  /** Call before the host's shortcuts; consumes the event when it returns true. */
  handleKey(key: KeyEvent): boolean
}

export type PromptProps = {
  focused: boolean
  cwd: string
  slashItems: SlashItem[]
  agent: { label: string; color: RGBA }
  model: { name: string; provider: string; variant?: string }
  location: string
  footerRight?: JSX.Element
  status: { running: boolean; interruptArmed: boolean }
  /** Reject to retain the draft, including images. */
  onSubmit(input: PromptSubmit): void | Promise<void>
  ref?: (api: PromptRef | undefined) => void
}
