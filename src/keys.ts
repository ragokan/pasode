import type { KeyEvent } from "@opentui/core"

/** One key press, e.g. ctrl+x. */
export type Stroke = { name: string; ctrl: boolean; shift: boolean; meta: boolean; super: boolean }

const aliases: Record<string, string> = { enter: "return", esc: "escape", cmd: "super", option: "meta", alt: "meta", del: "delete" }

/**
 * OpenCode keybind syntax: alternatives separated by ",", strokes in a sequence by spaces,
 * modifiers joined with "+", and "<leader>" for the leader stroke. "none" disables.
 */
export function parseBinding(spec: string | undefined, leader = "ctrl+x"): Stroke[][] {
  if (!spec || spec === "none") return []
  return spec
    .split(",")
    .map((alternative) =>
      alternative
        .trim()
        .replaceAll("<leader>", `${leader} `)
        .split(/\s+/)
        .filter(Boolean)
        .map(parseStroke),
    )
    // A typo'd modifier (control+x) drops its alternative rather than binding bare x, which would fire while typing.
    .filter((sequence): sequence is Stroke[] => sequence.length > 0 && !sequence.includes(undefined))
}

function parseStroke(token: string): Stroke | undefined {
  const stroke: Stroke = { name: "", ctrl: false, shift: false, meta: false, super: false }
  const parts = token.toLowerCase().split("+")
  stroke.name = aliases[parts.at(-1)!] ?? parts.at(-1)!
  for (const part of parts.slice(0, -1)) {
    const modifier = aliases[part] ?? part
    if (modifier !== "ctrl" && modifier !== "shift" && modifier !== "meta" && modifier !== "super") return undefined
    stroke[modifier] = true
  }
  return stroke
}

export function matchStroke(stroke: Stroke, key: Pick<KeyEvent, "name" | "ctrl" | "shift" | "meta" | "super">) {
  return (
    stroke.name === key.name &&
    stroke.ctrl === key.ctrl &&
    stroke.shift === key.shift &&
    stroke.meta === key.meta &&
    stroke.super === !!key.super
  )
}

// OpenCode's context/keymap.tsx formatOptions: key-name and modifier display aliases.
const display: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", pageup: "pgup", pagedown: "pgdn", delete: "del", meta: "alt" }

export function formatBinding(spec: string | undefined, leader = "ctrl+x") {
  const first = spec?.split(",")[0]?.trim()
  if (!first || first === "none") return undefined
  return first
    .replaceAll("<leader>", `${leader} `)
    .split(" ")
    .map((stroke) => stroke.split("+").map((part) => display[part] ?? part).join("+"))
    .join(" ")
}

/**
 * Sequence matcher: feed key presses, get back the id whose sequence completed,
 * "pending" while a longer sequence is still possible, or undefined.
 */
export function createKeymap(bindings: () => { id: string; sequences: Stroke[][] }[]) {
  let pressed: Pick<KeyEvent, "name" | "ctrl" | "shift" | "meta" | "super">[] = []
  return {
    get pending() {
      return pressed.length > 0
    },
    reset() {
      pressed = []
    },
    feed(key: Pick<KeyEvent, "name" | "ctrl" | "shift" | "meta" | "super">): string | "pending" | undefined {
      const next = [...pressed, key]
      let partial = false
      for (const { id, sequences } of bindings())
        for (const sequence of sequences) {
          if (sequence.length < next.length || !next.every((k, i) => matchStroke(sequence[i]!, k))) continue
          if (sequence.length === next.length) {
            pressed = []
            return id
          }
          partial = true
        }
      pressed = partial ? next : []
      return partial ? "pending" : undefined
    },
  }
}
