// Ported from OpenCode 2.0.26 component/logo.tsx + logo.ts (MIT): same glyph language, spelling "pas" + "ode".
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, type JSX } from "solid-js"
import { theme } from "./theme"

// "_" shadow cell, "^" letter-top over shadow, "~" shadow top half, "," shadow bottom half.
export const logo = {
  left: ["              ", "█▀▀█ ▀▀▀█ █▀▀▀", "█__█ █^^█ ^^^█", "█▀▀▀ ▀▀▀▀ ▀▀▀▀"],
  right: ["        ▄     ", "█▀▀█ █▀▀█ █▀▀█", "█__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const mix = (a: number, b: number) => Math.round((a + (b - a) * alpha) * 255)
  return RGBA.fromInts(mix(base.r, overlay.r), mix(base.g, overlay.g), mix(base.b, overlay.b))
}

export function Logo() {
  const dimensions = useTerminalDimensions()
  const renderLine = (line: string, fg: RGBA, bold: boolean): JSX.Element[] => {
    const shadow = tint(theme.background, fg, 0.25)
    const attrs = bold ? TextAttributes.BOLD : undefined
    return Array.from(line).map((char) => {
      if (char === "_") return <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>{" "}</text>
      if (char === "^") return <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>▀</text>
      if (char === "~") return <text fg={shadow} attributes={attrs} selectable={false}>▀</text>
      if (char === ",") return <text fg={shadow} attributes={attrs} selectable={false}>▄</text>
      return <text fg={fg} attributes={attrs} selectable={false}>{char}</text>
    })
  }
  return (
    <box>
      {dimensions().height < 12 ? null : dimensions().width < 22 ? (
        <For each={logo.right.slice(1)}>{(line) => <box flexDirection="row">{renderLine(line, theme.text, true)}</box>}</For>
      ) : dimensions().width < 44 ? (
        <>
          <For each={logo.left.slice(1)}>{(line) => <box flexDirection="row">{renderLine(line, theme.textMuted, false)}</box>}</For>
          <For each={logo.right}>{(line) => <box flexDirection="row">{renderLine(line, theme.text, true)}</box>}</For>
        </>
      ) : (
        <For each={logo.left}>
          {(line, index) => (
            <box flexDirection="row" gap={1}>
              <box flexDirection="row">{renderLine(line, theme.textMuted, false)}</box>
              <box flexDirection="row">{renderLine(logo.right[index()]!, theme.text, true)}</box>
            </box>
          )}
        </For>
      )}
    </box>
  )
}

/** OpenCode's util/presentation.ts sessionEpilogue: the wordmark and how to continue, printed on exit. */
export function sessionEpilogue(input: { title: string; id: string }) {
  const reset = "\x1b[0m"
  const bold = "\x1b[1m"
  const dim = "\x1b[90m"
  const draw = (line: string, fg: string, shadow: string, bg: string) =>
    [...line]
      .map((char) => {
        if (char === "_") return `${bg} ${reset}`
        if (char === "^") return `${fg}${bg}▀${reset}`
        if (char === "~") return `${shadow}▀${reset}`
        if (char === ",") return `${shadow}▄${reset}`
        if (char === " ") return " "
        return `${fg}${char}${reset}`
      })
      .join("")
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  return [
    ...logo.left.map((line, index) => `  ${draw(line, dim, "\x1b[38;5;235m", "\x1b[48;5;235m")} ${draw(logo.right[index] ?? "", reset, "\x1b[38;5;238m", "\x1b[48;5;238m")}`),
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    `  ${weak("Continue")}${bold}pasode -s ${input.id}${reset}`,
    "",
  ].join("\n")
}
