import { RGBA } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup } from "solid-js"

// OpenCode v2.0.26 ui/spinner.ts (MIT): blocks, width 8, trail 6, holds 9/30.
// Specialised to the prompt's settings; no opentui-spinner dependency.
export function blocksFrame(frame: number, color: RGBA) {
  frame %= 54
  const forward = frame < 17
  const holding = frame >= 8 && frame < 17 || frame >= 24
  const progress = frame < 8 ? frame : frame < 17 ? frame - 8 : frame < 24 ? frame - 17 : frame - 24
  const position = frame < 8 ? frame : frame < 17 ? 7 : frame < 24 ? 6 - progress : 0
  const fade = holding ? Math.max(0.3, 1 - progress / (forward ? 9 : 30) * 0.7) : 0.3 + progress / (forward ? 7 : 6) * 0.7
  return Array.from({ length: 8 }, (_, index) => {
    const distance = forward ? position - index : index - position
    const trail = holding ? distance + progress : distance >= 0 && distance < 6 ? distance : -1
    const active = trail >= 0 && trail < 6
    const brightness = trail === 1 && active ? 1.15 : 1
    const alpha = !active ? 0.6 * fade : trail === 0 ? 1 : trail === 1 ? 0.9 : Math.pow(0.65, trail - 1)
    return { text: active ? "■" : "⬝", color: RGBA.fromValues(Math.min(1, color.r * brightness), Math.min(1, color.g * brightness), Math.min(1, color.b * brightness), alpha) }
  })
}

export function PromptSpinner(props: { color: RGBA }) {
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => setFrame((frame) => (frame + 1) % 54), 40)
  onCleanup(() => clearInterval(timer))
  const blocks = createMemo(() => blocksFrame(frame(), props.color))
  return <text wrapMode="none"><For each={blocks()}>{(block) => <span style={{ fg: block.color }}>{block.text}</span>}</For></text>
}
