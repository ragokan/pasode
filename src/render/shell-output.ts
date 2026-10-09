const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// Ported from OpenCode 2.0.26 util/collapse-tool-output.ts (MIT); see OPENCODE-LICENSE.
export function collapseShellOutput(input: string, output: string, maxLines: number, maxChars: number) {
  if (!input) return { input, output: collapseTail(output, maxLines, maxChars), overflow: exceeds(output, maxLines, maxChars) }
  const command = collapseCommand(input, Math.min(2, maxLines), Math.max(1, Math.floor(maxChars / Math.max(1, maxLines))))
  if (!output) return { input: command.output, output, overflow: command.overflow }
  const lines = Math.max(1, maxLines - command.lines - 1)
  const chars = Math.max(1, maxChars - Array.from(command.output).length - 2)
  return { input: command.output, output: collapseTail(output, lines, chars), overflow: command.overflow || exceeds(output, lines, chars) }
}

// Ported from OpenCode 2.0.26 collapseShellCommand (MIT); see OPENCODE-LICENSE.
function collapseCommand(input: string, maxLines: number, lineWidth: number) {
  const visible: string[] = []
  let lines = 1
  let width = 0
  const overflow = Array.from(segmenter.segment(input), (item) => item.segment).some((segment) => {
    if (segment === "\n") {
      if (lines >= maxLines) return true
      visible.push(segment)
      lines++
      width = 0
      return false
    }
    const next = Bun.stringWidth(segment)
    if (width + next > lineWidth) {
      if (lines >= maxLines) return true
      lines++
      width = 0
    }
    visible.push(segment)
    width += next
    return false
  })
  if (!overflow) return { output: input, overflow, lines }
  if (width >= lineWidth) {
    const removed = visible.pop()
    if (removed !== undefined && removed !== "\n") width -= Bun.stringWidth(removed)
  }
  return { output: visible.join("") + "…", overflow, lines }
}

function exceeds(output: string, maxLines: number, maxChars: number) {
  return output.split("\n").length > maxLines || Array.from(output).length > maxChars
}

// Ported from OpenCode 2.0.26 collapseTail (MIT); see OPENCODE-LICENSE.
function collapseTail(output: string, maxLines: number, maxChars: number) {
  if (!exceeds(output, maxLines, maxChars)) return output
  const lines = output.split("\n")
  const count = Math.max(1, lines.length - Math.max(0, maxLines - 1))
  const label = `(${count} earlier ${count === 1 ? "line" : "lines"})`
  if (maxLines <= 1) return label
  const available = maxChars - Array.from(label).length - 1
  if (available <= 0) return label
  return `${label}\n${Array.from(lines.slice(-(maxLines - 1)).join("\n")).slice(-available).join("")}`
}
