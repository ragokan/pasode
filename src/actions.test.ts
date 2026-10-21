import { expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cycleAgent, exportTranscript } from "./actions"
import { dialogs } from "./dialog"
import { api, daemon, openTimeline, setAgents, setTimeline, type PaseoAgent } from "./paseo"
import { setAgentId, setPref, setToast, toast } from "./state"

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
