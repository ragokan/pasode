import { expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { canRedo, chooseMessage, cycleAgent, cycleChild, exportTranscript, fork, locateMessage, pin, redo, revertBlocker, revertTo } from "./actions"
import { dialogs } from "./dialog"
import { agents, api, daemon, openTimeline, setAgents, setTimeline, timeline, workspacePins, type PaseoAgent } from "./paseo"
import { agentId, draft, setAgentId, setDraft, setPref, setToast, toast } from "./state"

test('with permissions "prompt", Shift+Tab Plan→Build on Claude asks for the default mode, not Bypass', async () => {
  const modes: string[] = []
  const setAgentMode = spyOn(daemon, "setAgentMode").mockImplementation(async (_id, mode) => (modes.push(mode), null))
  try {
    setPref("permissions", "prompt")
    await cycleAgent({ id: "a", provider: "claude", currentModeId: "plan" } as PaseoAgent)
    setPref("permissions", "bypass")
    await cycleAgent({ id: "a", provider: "claude", currentModeId: "plan" } as PaseoAgent)
  } finally {
    setAgentMode.mockRestore()
  }
  expect(modes).toEqual(["default", "bypassPermissions"])
})

for (const change of ["replaced", "switched", "switched while prompting", "complete"]) {
  test(`export protects the destination when history is ${change}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pasode-export-"))
    const file = path.join(dir, "transcript.md")
    const row = (text: string) => ({ type: "assistant_message", text, messageId: text }) as const
    let resolve: ((page: unknown) => void) | undefined
    let exporting: Promise<void> | undefined
    const ref = spyOn(api.agents, "ref").mockImplementation(() => ({ timeline: { refetch: () => new Promise((done) => { resolve = done }) } }) as never)
    const selectOther = () => {
      setAgentId("export-b")
      setTimeline({ agentId: "export-b", rows: [row("other session")], times: [1000], marks: [], loading: false, hasOlder: false, startCursor: undefined })
    }
    const prompt = spyOn(dialogs, "prompt").mockImplementation(async () => {
      if (change === "switched while prompting") selectOther()
      return "transcript.md"
    })
    try {
      await openTimeline(undefined)
      await writeFile(file, "keep this file")
      setAgents("export-a", { id: "export-a", title: "Export A", provider: "claude", cwd: dir } as PaseoAgent)
      setAgents("export-b", { id: "export-b", title: "Export B", provider: "claude", cwd: dir } as PaseoAgent)
      setAgentId("export-a")
      setTimeline({ agentId: "export-a", rows: [row("newest")], times: [1000], marks: [], loading: false, hasOlder: true, startCursor: { epoch: "a", seq: 10 } })
      setToast(undefined)
      exporting = exportTranscript()
      await Bun.sleep(0)
      if (change !== "switched while prompting") {
        expect(resolve).toBeDefined()
        if (change === "replaced") setTimeline("rows", [row("replacement")])
        if (change === "switched") selectOther()
        resolve!({ entries: [{ item: row("oldest"), timestamp: new Date(1000).toISOString() }], hasOlder: false, startCursor: null })
      }
      await exporting
      const contents = await readFile(file, "utf8")
      if (change === "complete") {
        expect(contents).toContain("oldest")
        expect(contents).toContain("newest")
        expect(toast()?.variant).toBe("success")
      } else {
        expect(contents).toBe("keep this file")
        expect(toast()).toMatchObject({ variant: "error", message: "Session history changed during export; try again" })
      }
    } finally {
      await openTimeline(undefined)
      resolve?.({ entries: [], hasOlder: false, startCursor: null })
      await exporting
      setAgentId(undefined)
      setToast(undefined)
      ref.mockRestore()
      prompt.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

const pick = (index: number) => chooseMessage(timeline.rows[index] as never)!

// A session of three prompts; the provider supports rewinding as `capabilities` says.
const session = (capabilities: Partial<NonNullable<PaseoAgent["capabilities"]>>) => {
  const rows = [
    { type: "user_message", text: "first", messageId: "m1" },
    { type: "assistant_message", text: "a1" },
    { type: "user_message", text: "second", messageId: "m2" },
    { type: "assistant_message", text: "a2" },
    { type: "user_message", text: "third", messageId: "m3" },
  ] as const
  setAgents("rw", { id: "rw", provider: "claude", cwd: "/tmp", title: "Rewind me", capabilities } as PaseoAgent)
  setAgentId("rw")
  setTimeline({ agentId: "rw", rows: [...rows], times: rows.map((_, i) => 1000 + i), marks: [], loading: false, hasOlder: false, startCursor: undefined })
}

test("revert to a middle message rewinds there, restores its text and queues every undone prompt for redo in order", async () => {
  session({ supportsRewindBoth: true })
  const rewound: unknown[][] = []
  const rewind = spyOn(daemon, "rewindAgent").mockImplementation(async (...args) => (rewound.push(args), { ok: true, error: null, requestId: "r", agentId: "rw" }))
  const confirm = spyOn(dialogs, "confirm").mockResolvedValue(true)
  const sent: string[] = []
  const ref = spyOn(api.agents, "ref").mockImplementation(() => ({ send: async (text: string) => void sent.push(text) }) as never)
  try {
    const restored: string[] = []
    await revertTo(pick(2), (text) => restored.push(text))
    expect(confirm.mock.calls[0]![1]).toBe("Rewind 2 messages and roll back their file edits? Paseo can't restore the replies afterwards.")
    expect(rewound).toEqual([["rw", "m2", "both"]])
    expect(restored).toEqual(["second"])
    expect(toast()?.message).toBe("Undid 2 messages and their file changes")
    await redo()
    await redo()
    expect(sent).toEqual(["second", "third"])
    expect(canRedo()).toBe(false)
  } finally {
    rewind.mockRestore()
    confirm.mockRestore()
    ref.mockRestore()
    setAgentId(undefined)
    setToast(undefined)
  }
})

test("Codex rewinds the conversation only, and a provider that can't rewind says so without asking the daemon", async () => {
  const rewind = spyOn(daemon, "rewindAgent").mockResolvedValue({ ok: true, error: null, requestId: "r", agentId: "rw" })
  const confirm = spyOn(dialogs, "confirm").mockResolvedValue(true)
  try {
    session({ supportsRewindConversation: true })
    await revertTo(pick(4), () => {})
    expect(rewind.mock.calls).toEqual([["rw", "m3", "conversation"]])
    expect(toast()?.message).toBe("Undid the last message (files unchanged)")
    rewind.mockClear()
    session({})
    expect(revertBlocker(agents.rw!, timeline.rows[2] as never)).toBe("claude sessions can't rewind")
    await revertTo(pick(2), () => {})
    expect(rewind).not.toHaveBeenCalled()
    expect(toast()).toMatchObject({ variant: "warning", message: "claude sessions can't rewind" })
  } finally {
    rewind.mockRestore()
    confirm.mockRestore()
    setAgentId(undefined)
    setToast(undefined)
  }
})

test("fork from a message stops the history at the row before it and puts the message back in the prompt", async () => {
  session({})
  setTimeline("times", [1000, 1001, 1002, 1003, 1004])
  const prompts = ["first", "second", "third"].map((text, i) => ({ seq: 1 + i * 2, timestamp: new Date(1000 + i * 2).toISOString(), preview: text }))
  const list = spyOn(daemon, "listAgentTimelinePrompts").mockResolvedValue({ epoch: "e", prompts, requestId: "r", agentId: "rw", error: null } as never)
  const fetched: unknown[] = []
  const page = spyOn(daemon, "fetchAgentTimeline").mockImplementation(async (_id, options) => (fetched.push(options), { reset: false, epoch: "e", entries: [{ seqEnd: 4 }] }) as never)
  const built: unknown[] = []
  const context = spyOn(daemon, "buildAgentForkContext").mockImplementation(async (_id, options) => (built.push(options), { attachment: { type: "text", text: "summary" } }) as never)
  try {
    const restored: string[] = []
    await fork({ chosen: pick(2), restore: (text) => restored.push(text) })
    // "second" is prompt seq 3: the row before it ends at seq 4 in this fake, so the boundary comes from that fetch.
    expect(fetched).toEqual([{ direction: "before", cursor: { epoch: "e", seq: 3 }, limit: 1, projection: "projected" }])
    expect(built).toEqual([{ boundaryCursor: { epoch: "e", seq: 4 } }])
    expect(restored).toEqual(["second"])
    expect(draft().fork).toMatchObject({ title: "Rewind me", cwd: "/tmp", attachment: { text: "summary" } })
    expect(agentId()).toBeUndefined()

    // Forking the whole session sends no boundary.
    session({})
    built.length = 0
    await fork()
    expect(built).toEqual([undefined])

    // The first message has nothing before it: no history to carry, same directory.
    session({})
    setTimeline("times", [1000, 1001, 1002, 1003, 1004])
    page.mockImplementation(async () => ({ reset: false, epoch: "e", entries: [] }) as never)
    built.length = 0
    await fork({ chosen: pick(0), restore: (text) => restored.push(text) })
    expect(built).toEqual([])
    expect(draft()).toMatchObject({ cwd: "/tmp", fork: undefined })
    expect(restored).toEqual(["second", "first"])
  } finally {
    list.mockRestore()
    page.mockRestore()
    context.mockRestore()
    setAgentId(undefined)
    setDraft({ provider: "claude" })
    setToast(undefined)
  }
})

test("next/previous child cycles the siblings, and from the parent enters at either end", () => {
  const at = (id: string, created: number, parent?: string) =>
    ({ id, createdAt: new Date(created).toISOString(), labels: parent ? { "paseo.parent-agent-id": parent } : {} }) as unknown as PaseoAgent
  setAgents({ p: at("p", 0), c1: at("c1", 1, "p"), c2: at("c2", 2, "p"), c3: at("c3", 3, "p"), other: at("other", 4) })
  const visit = (id: string, delta: 1 | -1) => (setAgentId(id), cycleChild(delta), agentId())
  expect([visit("p", 1), visit("p", -1), visit("c1", 1), visit("c3", 1), visit("c1", -1)]).toEqual(["c1", "c3", "c2", "c1", "c3"])
  setAgentId("other")
  cycleChild(1)
  expect(agentId()).toBe("other")
  expect(toast()?.message).toBe("No child sessions")
  setAgentId(undefined)
  setAgents({})
  setToast(undefined)
})

test("pinning a lone session's workspace asks the daemon and records it; a shared workspace is refused", async () => {
  setAgents({ a: { id: "a", workspaceId: "w1" } as PaseoAgent, b: { id: "b", workspaceId: "w2" } as PaseoAgent, c: { id: "c", workspaceId: "w2" } as PaseoAgent })
  const pinned = spyOn(daemon, "setWorkspacePinned").mockImplementation(async (_id, value) => ({ pinnedAt: value ? "2026-01-01T00:00:00Z" : null }))
  try {
    await pin("a")
    expect(workspacePins.w1).toBe("2026-01-01T00:00:00Z")
    await pin("a")
    expect(workspacePins.w1).toBeNull()
    expect(pinned.mock.calls).toEqual([["w1", true], ["w1", false]])
    await pin("b")
    expect(pinned).toHaveBeenCalledTimes(2)
    expect(toast()?.variant).toBe("warning")
  } finally {
    pinned.mockRestore()
    setAgents({})
    setToast(undefined)
  }
})

test("revert rewinds the message that was chosen even if a refetch rewrites the row, or moves it, while the confirmation is up", async () => {
  session({ supportsRewindBoth: true })
  const rewound: unknown[][] = []
  const rewind = spyOn(daemon, "rewindAgent").mockImplementation(async (...args) => (rewound.push(args), { ok: true, error: null, requestId: "r", agentId: "rw" }))
  let answer!: (ok: boolean) => void
  const confirm = spyOn(dialogs, "confirm").mockImplementation(() => new Promise((resolve) => (answer = resolve)))
  try {
    const restored: string[] = []
    // A reconnect refetch merges rows in place: the row object the dialog holds now carries another prompt.
    let reverting = revertTo(pick(2), (text) => restored.push(text))
    setTimeline("rows", 2, { messageId: "m9", text: "someone else's prompt" } as never)
    answer(true)
    await reverting
    expect(rewound).toEqual([])
    expect(restored).toEqual([])
    expect(toast()).toMatchObject({ variant: "warning", message: "That message is no longer in the session" })

    // Older history prepended meanwhile only moves the row: the same message is still the target.
    session({ supportsRewindBoth: true })
    setToast(undefined)
    reverting = revertTo(pick(2), (text) => restored.push(text))
    setTimeline("rows", (rows) => [{ type: "user_message", text: "older", messageId: "m0" } as never, ...rows])
    setTimeline("times", (times) => [999, ...times])
    answer(true)
    await reverting
    expect(rewound).toEqual([["rw", "m2", "both"]])
    expect(restored).toEqual(["second"])

    // Switching to another session during the confirmation drops it.
    session({ supportsRewindBoth: true })
    rewound.length = 0
    reverting = revertTo(pick(2), () => {})
    setAgentId(undefined)
    answer(true)
    await reverting
    expect(rewound).toEqual([])
  } finally {
    rewind.mockRestore()
    confirm.mockRestore()
    setAgentId(undefined)
    setToast(undefined)
  }
})

test("fork stops when the chosen message changes while the daemon is asked for its position", async () => {
  session({})
  let answer!: (page: never) => void
  const list = spyOn(daemon, "listAgentTimelinePrompts").mockImplementation(() => new Promise((resolve) => (answer = resolve as never)))
  const context = spyOn(daemon, "buildAgentForkContext")
  try {
    const forking = fork({ chosen: pick(2), restore: () => {} })
    setTimeline("rows", 2, { messageId: "m9", text: "someone else's prompt" } as never)
    answer({ epoch: "e", prompts: [] } as never)
    await forking
    expect(context).not.toHaveBeenCalled()
    expect(toast()).toMatchObject({ variant: "error", message: "That message is no longer in the session" })
  } finally {
    list.mockRestore()
    context.mockRestore()
    setAgentId(undefined)
    setToast(undefined)
  }
})

test("a repeated prompt is told apart by its client id, or by its time and place when it has no id at all", async () => {
  // Codex's out-of-band prompts (/goal pause) carry a clientMessageId but no messageId.
  const repeated = (ids: boolean, times: number[]) => {
    const rows = ["user_message", "assistant_message", "user_message"].map((type, i) => ({ type, text: type === "user_message" ? "/goal pause" : "ok", ...(ids && type === "user_message" ? { clientMessageId: `c${i}` } : {}) }))
    setAgents("rep", { id: "rep", provider: "codex", cwd: "/tmp", title: "Repeats" } as PaseoAgent)
    setAgentId("rep")
    setTimeline({ agentId: "rep", rows: rows as never, times, marks: [], loading: false, hasOlder: false, startCursor: undefined })
  }
  const list = spyOn(daemon, "listAgentTimelinePrompts").mockResolvedValue({
    epoch: "e",
    prompts: [{ seq: 1, timestamp: new Date(1000).toISOString(), preview: "/goal pause" }, { seq: 3, timestamp: new Date(2000).toISOString(), preview: "/goal pause" }],
  } as never)
  const page = spyOn(daemon, "fetchAgentTimeline").mockResolvedValue({ reset: false, epoch: "e", entries: [] } as never)
  try {
    for (const [ids, times] of [[true, [1000, 1001, 2000]], [false, [1000, 1001, 2000]], [false, [1000, 1001, 1000]]] as const) {
      repeated(ids, [...times])
      expect([0, 2].map((index) => locateMessage(pick(index)))).toEqual([0, 2])
      page.mockClear()
      // With the same timestamp on both, the daemon's index can't tell them apart either; only the order does.
      list.mockResolvedValue({ epoch: "e", prompts: [1, 3].map((seq, i) => ({ seq, timestamp: new Date(times[i * 2]!).toISOString(), preview: "/goal pause" })) } as never)
      await fork({ chosen: pick(0), restore: () => {} })
      expect(page.mock.calls[0]![1]!.cursor!.seq).toBe(1)
    }
  } finally {
    list.mockRestore()
    page.mockRestore()
    setAgentId(undefined)
    setDraft({ provider: "claude" })
    setToast(undefined)
  }
})
