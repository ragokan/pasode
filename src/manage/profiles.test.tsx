import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { createSession } from "../actions"
import { dialog, DialogHost } from "../dialog"
import { api, daemon, setAgents, setCatalog, type PaseoAgent } from "../paseo"
import { draft, setAgentId, setDraft, setToast, toast } from "../state"
import { applyConfig, materialize, openProfiles, profileDraft, profileSummary } from "./profiles"

let screen: TestRendererSetup | undefined
const mocks: { mockRestore(): void }[] = []
afterEach(() => {
  dialog.clear() // the dialog state is global; a left-open one swallows later tests' keys
  screen?.renderer.destroy()
  screen = undefined
  while (mocks.length) mocks.pop()!.mockRestore()
  setAgentId(undefined)
  setCatalog("claude", [])
  setDraft({ provider: "claude" })
  setToast(undefined)
})

const profile = (extra: Record<string, unknown> = {}) => ({ id: "p1", name: "Main", provider: "claude", model: "claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "xhigh", ...extra }) as never
const withCatalog = () => setCatalog("claude", [{ id: "claude-opus-5-5", label: "Opus 5.5", thinkingOptions: [{ id: "xhigh", label: "Extra high" }] }] as never)

test("blank profile fields mean 'leave alone'; the summary reads like the Paseo app's", () => {
  expect(materialize(profile({ model: "  ", modeId: "", thinkingOptionId: undefined, featureValues: {} }))).toEqual({ provider: "claude", model: undefined, modeId: undefined, thinking: undefined, featureValues: undefined })
  expect(profileSummary(profile({ featureValues: { fast_mode: true } }))).toBe("Claude Code · claude-opus-5-5 · bypassPermissions · xhigh · 1 feature")
  withCatalog()
  expect(profileSummary(profile({ featureValues: { a: 1, b: 2 } }))).toBe("Claude Code · Opus 5.5 · bypassPermissions · Extra high · 2 features")
})

test("at home a profile sets the draft's model and effort, and keeps its mode for the new session", () => {
  withCatalog()
  expect(profileDraft(profile({ featureValues: { fast_mode: true } }), { provider: "codex", agent: "plan", cwd: "/x" })).toEqual({
    provider: "claude",
    model: "claude-opus-5-5",
    label: "Opus 5.5",
    thinking: "xhigh",
    agent: undefined,
    cwd: "/x",
    profile: { name: "Main", provider: "claude", config: { modeId: "bypassPermissions", featureValues: { fast_mode: true } } },
  })
})

test("in a session a profile applies model, effort, features and a mode the session offers", () => {
  const offers = { availableModes: [{ id: "plan" }, { id: "bypassPermissions" }] } as Pick<PaseoAgent, "availableModes">
  expect(applyConfig(profile({ featureValues: { fast_mode: true } }), offers)).toEqual({ modelId: "claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "xhigh", featureValues: { fast_mode: true } })
  expect(applyConfig(profile(), { availableModes: [{ id: "plan" }] } as Pick<PaseoAgent, "availableModes">)).toEqual({ modelId: "claude-opus-5-5", thinkingOptionId: "xhigh" })
  expect(applyConfig(profile({ model: "", modeId: "", thinkingOptionId: "" }), offers)).toEqual({})
})

test("createSession starts in the profile's mode and features, unless Plan or another provider is chosen", async () => {
  const configs: Record<string, unknown>[] = []
  mocks.push(spyOn(api.agents, "create").mockImplementation((async (options: { config: Record<string, unknown> }) => (configs.push(options.config), { id: "new" })) as never))
  const start = async (draftValue: Parameters<typeof setDraft>[0]) => {
    setDraft(draftValue)
    await createSession("hi")
  }
  const base = profileDraft(profile({ modeId: "acceptEdits", featureValues: { fast_mode: true } }), { provider: "claude" })
  await start(base)
  await start({ ...base, agent: "plan" })
  await start({ ...base, provider: "codex", model: "gpt-5" })
  expect(configs).toEqual([
    { provider: "claude/claude-opus-5-5", modeId: "acceptEdits", featureValues: { fast_mode: true }, thinkingOptionId: "xhigh" },
    { provider: "claude/claude-opus-5-5", modeId: "plan", thinkingOptionId: "xhigh" },
    { provider: "codex/gpt-5", modeId: "full-access", thinkingOptionId: "xhigh" },
  ])
  expect(draft().profile).toBeUndefined() // spent with the session
})

test("/profiles lists the daemon's profiles for the supported providers; at home it picks, in a session it applies", async () => {
  const features = spyOn(daemon, "getLastServerInfoMessage").mockReturnValue({ features: { agentProfiles: true, agentConfigApply: true } } as never)
  const profiles = [profile(), profile({ id: "p2", name: "Pi", provider: "pi", model: "x" }), profile({ id: "p3", name: "Codex fast", provider: "codex", model: "gpt-5", modeId: "full-access", thinkingOptionId: undefined })]
  mocks.push(features, spyOn(api.config, "get").mockResolvedValue({ requestId: "r", config: { agentProfiles: profiles } } as never))
  const apply = spyOn(daemon, "applyAgentConfig").mockResolvedValue({ type: "info", message: "Model changes next turn" })
  mocks.push(apply)

  screen = await testRender(() => <DialogHost />, { width: 110, height: 30 })
  await openProfiles()
  await screen.renderOnce()
  let frame = screen.captureCharFrame()
  expect(frame).toContain("Agent profiles")
  expect(frame).toMatch(/Main\s+Claude Code/)
  expect(frame).toMatch(/Codex fast\s+Codex/)
  expect(frame).not.toContain("Pi ")
  screen.mockInput.pressArrow("down")
  screen.mockInput.pressEnter()
  await screen.renderOnce()
  expect(draft()).toMatchObject({ provider: "codex", model: "gpt-5", profile: { name: "Codex fast", config: { modeId: "full-access" } } })
  expect(toast()?.message).toBe("Next session uses Codex fast")

  setAgents({ s: { id: "s", title: "S", provider: "claude", cwd: "/x", availableModes: [{ id: "bypassPermissions" }] } as PaseoAgent })
  setAgentId("s")
  await openProfiles()
  await screen.renderOnce()
  frame = screen.captureCharFrame()
  expect(frame).toContain("Apply profile to this session · Claude Code")
  expect(frame).not.toContain("Codex fast")
  screen.mockInput.pressEnter()
  await Bun.sleep(0)
  expect(apply).toHaveBeenCalledWith("s", { modelId: "claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "xhigh" })
  expect(toast()).toMatchObject({ variant: "info", message: "Model changes next turn" })
})

test("a daemon without agent profiles says so", async () => {
  mocks.push(spyOn(daemon, "getLastServerInfoMessage").mockReturnValue({ features: {} } as never))
  await openProfiles()
  expect(toast()).toMatchObject({ variant: "warning", message: expect.stringContaining("doesn't support agent profiles") })
})
