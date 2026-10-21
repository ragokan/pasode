import { afterEach, expect, spyOn, test } from "bun:test"
import { kvGet } from "./config"
import { cycleRecentModel, favoriteModels, modelSections, nextRecent, recentModels, rememberModel, toggleFavorite } from "./models"
import { daemon, setAgents, setCatalog, type PaseoAgent } from "./paseo"
import { draft, setAgentId, setDraft, setToast, toast } from "./state"

const option = (provider: string, id: string) => ({ title: id.toUpperCase(), value: `${provider}/${id}`, category: provider })

afterEach(() => setAgentId(undefined))

test("picker rows: Favorites, then Recent without favorites, then the rest once; unknown ids are dropped", () => {
  const all = [option("claude", "opus"), option("claude", "sonnet"), option("codex", "gpt")]
  const rows = modelSections(all, ["codex/gpt"], ["claude/sonnet", "codex/gpt", "claude/retired"])
  expect(rows.map((row) => [row.value, row.category])).toEqual([
    ["codex/gpt", "Favorites"],
    ["claude/sonnet", "Recent"],
    ["claude/opus", "claude"],
  ])
  expect(rows[0]!.description).toBe("Codex")
  expect(modelSections(all, [], [])).toEqual(all)
})

test("f2 steps through recents and wraps; an unlisted current model starts at the newest", () => {
  expect(nextRecent([], "a")).toBeUndefined()
  expect(nextRecent(["a", "b", "c"], "a")).toBe("b")
  expect(nextRecent(["a", "b", "c"], "c")).toBe("a")
  expect(nextRecent(["a", "b", "c"], "zzz")).toBe("a")
})

test("recents are newest-first without repeats and capped; favorites toggle; both persist", () => {
  for (let i = 0; i < 12; i++) rememberModel(`claude/m${i}`)
  rememberModel("claude/m5")
  expect(recentModels()).toHaveLength(10)
  expect(recentModels()[0]).toBe("claude/m5")
  expect(recentModels().filter((id) => id === "claude/m5")).toHaveLength(1)
  toggleFavorite("codex/fav")
  expect(favoriteModels()).toContain("codex/fav")
  expect(kvGet<{ favorite: string[]; recent: string[] }>("models", { favorite: [], recent: [] })).toEqual({ favorite: favoriteModels(), recent: recentModels() })
  toggleFavorite("codex/fav")
  expect(favoriteModels()).not.toContain("codex/fav")
})

test("cycling on the home screen moves the draft to the next recent model", () => {
  setCatalog("claude", [{ id: "cy-a", label: "Cy A" }, { id: "cy-b", label: "Cy B" }] as never)
  rememberModel("claude/cy-a")
  rememberModel("claude/cy-b") // newest first: b, a
  setDraft({ provider: "claude", model: "cy-a", thinking: "high" })
  cycleRecentModel()
  expect(draft()).toMatchObject({ provider: "claude", model: "cy-b", label: "Cy B", thinking: undefined })
  cycleRecentModel()
  expect(draft().model).toBe("cy-a")
})

test("cycling a live session keeps its provider and skips models the catalog lacks", () => {
  setCatalog("claude", [{ id: "cy-a", label: "Cy A" }, { id: "cy-b", label: "Cy B" }] as never)
  rememberModel("claude/cy-a")
  rememberModel("codex/not-in-catalog")
  rememberModel("claude/cy-gone")
  rememberModel("claude/cy-b") // newest first: b, gone, codex, a
  setAgents("cycle", { id: "cycle", provider: "claude", model: "cy-b", cwd: "/tmp" } as PaseoAgent)
  setAgentId("cycle")
  const set = spyOn(daemon, "setAgentModel").mockResolvedValue(undefined as never)
  try {
    cycleRecentModel()
    expect(set).toHaveBeenCalledWith("cycle", "cy-a")
  } finally {
    set.mockRestore()
  }
})

test("with no other recent model it says so instead of doing nothing silently", () => {
  setCatalog("solo", [{ id: "s1", label: "S1" }] as never)
  rememberModel("solo/s1")
  setAgents("single", { id: "single", provider: "solo", model: "s1", cwd: "/tmp" } as PaseoAgent)
  setAgentId("single")
  setToast(undefined)
  const set = spyOn(daemon, "setAgentModel").mockResolvedValue(undefined as never)
  try {
    cycleRecentModel()
    expect(set).not.toHaveBeenCalled()
    expect(toast()?.message).toBe("No other recent model yet")
  } finally {
    set.mockRestore()
  }
})
