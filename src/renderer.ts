import type { CliRendererConfig } from "@opentui/core"

export const rendererOptions = {
  exitOnCtrlC: false,
  // Like OpenCode: clicks must not move focus off the prompt (the transcript scrollbox is focusable).
  autoFocus: false,
} satisfies CliRendererConfig
