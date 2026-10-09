const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// Ported from OpenCode 2.0.26 ui/file-path.tsx (MIT); see OPENCODE-LICENSE.
export function truncateFilePath(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (Bun.stringWidth(value) <= maxWidth) return value
  const drive = value.match(/^([A-Za-z]:)([\\/])/)
  const unc = value.match(/^(\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/)
  const windows = drive !== null || unc !== null || (!value.includes("/") && value.includes("\\"))
  const separator = drive?.[2] ?? (unc?.[1] === "//" ? "/" : windows ? "\\" : "/")
  const root = drive ? drive[1]! + separator : unc ? unc[1]! + unc[2]! + separator + unc[3]! + separator : value.startsWith("/") ? "/" : ""
  const source = value.slice(drive?.[0].length ?? unc?.[0].length ?? root.length)
  const segments = source.split(windows ? /[\\/]/ : separator).filter(Boolean)
  const basename = segments.at(-1) ?? value
  if (segments.length < 2) {
    const rootWidth = Bun.stringWidth(root)
    if (rootWidth >= maxWidth) return take(root, maxWidth)
    return root + truncateBasename(basename, maxWidth - rootWidth)
  }
  const prefix = `${root}…${separator}`
  const basenameWidth = maxWidth - Bun.stringWidth(prefix)
  if (basenameWidth <= 0) return take(prefix, maxWidth)
  const compact = truncateBasename(basename, basenameWidth)
  if (compact !== basename) return prefix + compact
  const selected = [basename]
  const separatorWidth = Bun.stringWidth(separator)
  let width = Bun.stringWidth(prefix + basename)
  for (let index = segments.length - 2; index >= 0; index--) {
    const segment = segments[index]!
    const next = Bun.stringWidth(segment) + separatorWidth
    if (width + next > maxWidth) {
      const available = maxWidth - width - separatorWidth
      if (available > 1) selected.unshift(take(segment, available - 1) + "…")
      break
    }
    selected.unshift(segment)
    width += next
  }
  return prefix + selected.join(separator)
}

// Ported from OpenCode 2.0.26 ui/file-path.tsx truncateBasename/take (MIT); see OPENCODE-LICENSE.
function truncateBasename(value: string, maxWidth: number): string {
  if (Bun.stringWidth(value) <= maxWidth) return value
  if (maxWidth <= 1) return take("…", maxWidth)
  const dot = value.lastIndexOf(".")
  const extension = dot > 0 ? value.slice(dot) : ""
  const extensionWidth = Bun.stringWidth(extension)
  if (extensionWidth >= maxWidth) return "…" + take(extension, maxWidth - 1, true)
  return take(extension ? value.slice(0, dot) : value, maxWidth - extensionWidth - 1) + "…" + extension
}

function take(value: string, maxWidth: number, reverse = false): string {
  const segments = Array.from(segmenter.segment(value), (item) => item.segment)
  if (reverse) segments.reverse()
  const selected: string[] = []
  let width = 0
  for (const segment of segments) {
    const next = Bun.stringWidth(segment)
    if (width + next > maxWidth) break
    selected.push(segment)
    width += next
  }
  if (reverse) selected.reverse()
  return selected.join("")
}
