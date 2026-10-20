import type { CliRenderer, CliRendererConfig } from "@opentui/core"

// Over SSH the terminal keeps sending mouse reports until "mouse off" reaches it, and destroy() leaves raw mode at
// once, so late reports would echo and land in the shell as text. Turn the mouse off and keep reading for a round trip.
// shortcut: a fixed 200 ms covers links up to ~200 ms RTT; wait for input to go idle instead if slower links leak.
export function quit(renderer: Pick<CliRenderer, "useMouse" | "destroy">, drainMs = 200) {
  if (!renderer.useMouse) return renderer.destroy()
  renderer.useMouse = false
  setTimeout(() => renderer.destroy(), drainMs)
}

export const rendererOptions = {
  exitOnCtrlC: false,
  // Like OpenCode: clicks must not move focus off the prompt (the transcript scrollbox is focusable).
  autoFocus: false,
} satisfies CliRendererConfig
