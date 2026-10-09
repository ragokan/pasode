// OpenCode 2.0.26 prompt/display.ts (MIT): "/" completion anywhere in the prompt, not just at its start.

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Textarea cursor offsets count display width, with a newline as one position. */
export function offsetWidth(value: string) {
  let width = 0
  for (const part of graphemes.segment(value)) width += part.segment === "\n" ? 1 : Bun.stringWidth(part.segment)
  return width
}

/** slashTriggerIndex: a "/" at the start or after whitespace, with no whitespace or further "/" up to the cursor. */
export function slashTrigger(beforeCursor: string) {
  for (let index = beforeCursor.lastIndexOf("/"); index >= 0; index = beforeCursor.lastIndexOf("/", index - 1)) {
    const previous = index === 0 ? undefined : beforeCursor[index - 1]
    const query = beforeCursor.slice(index)
    if (previous !== undefined && !/\s/.test(previous)) continue
    if (/\s/.test(query) || query.slice(1).includes("/")) return
    return { index, query: query.slice(1) }
  }
}
