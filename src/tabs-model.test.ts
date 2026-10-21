import { expect, test } from "bun:test"
import { closeTab, cycleTab, openTab, overflowWidth, tabLayout, TAB_MAX_WIDTH, TAB_MIN_WIDTH } from "./tabs-model"

test("openTab appends once; closeTab names the neighbour that takes over", () => {
  const tabs = openTab(openTab(["a"], "b"), "a")
  expect(tabs).toEqual(["a", "b"])
  expect(openTab(tabs, "b")).toBe(tabs)
  expect(closeTab(["a", "b", "c"], "b")).toEqual({ tabs: ["a", "c"], next: "c" })
  expect(closeTab(["a", "b", "c"], "c")).toEqual({ tabs: ["a", "b"], next: "b" })
  expect(closeTab(["a"], "a")).toEqual({ tabs: [], next: undefined })
  const same = ["a"]
  expect(closeTab(same, "z")).toEqual({ tabs: same, next: undefined })
})

test("cycleTab wraps, and from outside the list starts at the first (or last) tab", () => {
  const tabs = ["a", "b", "c"]
  expect([cycleTab(tabs, "a", 1), cycleTab(tabs, "c", 1), cycleTab(tabs, "a", -1), cycleTab(tabs, "b", -1)]).toEqual(["b", "a", "c", "a"])
  expect([cycleTab(tabs, undefined, 1), cycleTab(tabs, undefined, -1), cycleTab([], "a", 1)]).toEqual(["a", "c", undefined])
})

test("tabLayout shows every tab when they fit, at a width between the min and max", () => {
  expect(tabLayout(3, 1, 80)).toMatchObject({ start: 0, shown: 3, before: 0, after: 0, width: TAB_MAX_WIDTH })
  expect(tabLayout(4, 0, 60)).toMatchObject({ shown: 4, width: 15 })
})

test("tabLayout windows around the active tab, keeping room for the overflow markers", () => {
  const total = 12
  const available = 50
  for (let active = 0; active < total; active++) {
    const { start, shown, before, after, width } = tabLayout(total, active, available)
    expect(active).toBeGreaterThanOrEqual(start)
    expect(active).toBeLessThan(start + shown)
    expect(before + shown + after).toBe(total)
    expect(width).toBeGreaterThanOrEqual(TAB_MIN_WIDTH)
    const used = shown * width + (before ? overflowWidth(before) : 0) + (after ? overflowWidth(after) : 0)
    expect(used).toBeLessThanOrEqual(available)
  }
  // Scrolls only as far as needed: moving right by one keeps the window until the active tab leaves it.
  const first = tabLayout(total, 0, available)
  expect(tabLayout(total, 1, available, first.start).start).toBe(0)
  const edge = tabLayout(total, first.shown, available, first.start)
  expect(edge.start).toBe(1)
  expect(tabLayout(total, first.shown - 1, available, edge.start).start).toBe(1)
})

test("tabLayout always shows at least the active tab, even in a sliver", () => {
  expect(tabLayout(5, 4, 6)).toMatchObject({ shown: 1, start: 4 })
  expect(tabLayout(5, -1, 30)).toMatchObject({ start: 0 })
})
