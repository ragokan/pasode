// Ported from OpenCode's context/session-tabs-model.ts (MIT), trimmed to ids: open/close/cycle and the adaptive window.
export const TAB_MIN_WIDTH = 10
export const TAB_MAX_WIDTH = 24
/** The bar is hidden below this terminal width. */
export const TAB_BAR_MIN_COLUMNS = 40

/** Cells an overflow marker takes, e.g. "‹12 " and " 12›". */
export const overflowWidth = (count: number) => String(count).length + 2

export const openTab = (tabs: readonly string[], id: string) => (tabs.includes(id) ? tabs : [...tabs, id])

/** The tabs without `id`, and where to go if it was the current one: the tab that slides into its place, else the one before. */
export function closeTab(tabs: readonly string[], id: string) {
  const index = tabs.indexOf(id)
  if (index === -1) return { tabs, next: undefined }
  return { tabs: tabs.filter((tab) => tab !== id), next: tabs[index + 1] ?? tabs[index - 1] }
}

/** The tab `direction` steps from `active`, wrapping; from outside the list, the first (or last) one. */
export function cycleTab(tabs: readonly string[], active: string | undefined, direction: 1 | -1) {
  if (!tabs.length) return undefined
  const index = tabs.indexOf(active!)
  if (index === -1) return direction === 1 ? tabs[0] : tabs.at(-1)
  return tabs[(index + direction + tabs.length) % tabs.length]
}

/**
 * Which tabs fit in `available` cells: a window of at least TAB_MIN_WIDTH-wide tabs that keeps `active` in view,
 * scrolling from `previousStart` only as far as needed, with room reserved for the "‹n" / "n›" overflow markers.
 */
export function tabLayout(total: number, active: number, available: number, previousStart = 0) {
  const fit = (room: number) => Math.min(total, Math.max(1, Math.floor(room / TAB_MIN_WIDTH)))
  let shown = fit(available)
  let start = 0
  let markers = 0
  // Markers take room that can shrink the window, which can move them; settle in a few passes.
  for (let pass = 0; pass < 3; pass++) {
    start = Math.min(Math.max(0, previousStart), total - shown)
    if (active >= 0) start = active < start ? active : active >= start + shown ? active - shown + 1 : start
    markers = (start > 0 ? overflowWidth(start) : 0) + (start + shown < total ? overflowWidth(total - start - shown) : 0)
    const next = fit(available - markers)
    if (next === shown) break
    shown = next
  }
  const width = Math.min(TAB_MAX_WIDTH, Math.max(TAB_MIN_WIDTH, Math.floor((available - markers) / shown)))
  return { start, shown, before: start, after: total - start - shown, width }
}
