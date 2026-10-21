// Clipboard writes for copyText: OSC 52 through OpenTUI (it owns stdout) plus the host clipboard where one exists.
import type { CliRenderer } from "@opentui/core"

let renderer: Pick<CliRenderer, "copyToClipboardOSC52"> | undefined
export const useClipboardRenderer = (value: typeof renderer) => (renderer = value)

/** Host clipboard writers by platform, in the order tried: Wayland, then X11. */
export function hostClipboardCommands(platform: NodeJS.Platform): string[][] {
  if (platform === "darwin") return [["pbcopy"]]
  if (platform === "linux") return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
  return []
}

type Child = { stdin: { write(text: string): unknown; end(): unknown }; exited: Promise<number> }
const spawn = (command: string[]): Child => Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" })

/** First writer that exits 0 wins; a missing binary or one that can't reach its display (wl-copy on X11) falls through. */
export async function writeHostClipboard(text: string, commands = hostClipboardCommands(process.platform), start = spawn) {
  for (const command of commands) {
    try {
      const child = start(command)
      child.stdin.write(text)
      await child.stdin.end()
      if ((await child.exited) === 0) return true
    } catch {}
  }
  return false
}

/** Whether any destination took the text. OSC 52 over SSH/tmux can't be confirmed, so it counts as taken once sent. */
export async function copyToClipboard(text: string) {
  const sent = renderer?.copyToClipboardOSC52(text) ?? false
  return (await writeHostClipboard(text)) || sent
}
