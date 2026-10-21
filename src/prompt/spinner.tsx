import { RGBA } from "@opentui/core"
import { createEffect, createMemo, createSignal, Index, onCleanup, Show } from "solid-js"
import { prefs } from "../state"
import { theme } from "../theme"

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

const [tick, setTick] = createSignal(0)
let spinners = 0
let timer: ReturnType<typeof setInterval> | undefined

/** One 80 ms clock for every spinner (OpenCode ticks at 25 fps; this is every other frame). It runs only while a spinner is mounted with animations on. */
export function spinnerTick() {
  createEffect(() => {
    if (!prefs.animations) return
    if (!spinners++) timer = setInterval(() => setTick((value) => value + 1), 80)
    onCleanup(() => {
      if (!--spinners) clearInterval(timer)
    })
  })
  return tick
}

export function PromptSpinner(props: { color: RGBA }) {
  const tick = spinnerTick()
  const blocks = createMemo(() => blocksFrame(tick() * 2, props.color))
  // OpenCode's still prompt indicator with animations off.
  return <Show when={prefs.animations} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
    {/* Index keeps the spans and updates their text and color; For rebuilt all eight every frame. */}
    <text wrapMode="none"><Index each={blocks()}>{(block) => <span style={{ fg: block().color }}>{block().text}</span>}</Index></text>
  </Show>
}
