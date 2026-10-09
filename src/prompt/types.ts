import type { PaseoAgentSendOptions } from "@getpaseo/client"
import type { KeyEvent } from "@opentui/core"
import type { JSX } from "@opentui/solid"

export type PromptSubmit = {
  text: string
  mode: "normal" | "shell"
  images: NonNullable<PaseoAgentSendOptions["images"]>
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
  placeholder: string
  cwd: string
  slashItems: SlashItem[]
  footer: JSX.Element
  /** Reject to retain the draft, including images. */
  onSubmit(input: PromptSubmit): void | Promise<void>
  ref?: (api: PromptRef | undefined) => void
}
