import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { setAgents, type PaseoAgent } from "../paseo"
import { dequeue, enqueue, queueOf, sendQueued } from "./queue"

const item = (text: string) => ({ text, images: [] })
const agent = (id: string, status: string, pendingPermissions: unknown[] = []) => ({ id, status, pendingPermissions }) as unknown as PaseoAgent

test("queued prompts go out one per finished turn, in order", () => {
  setAgents({ q1: agent("q1", "running") })
  const sent: string[] = []
  const dispose = createRoot((dispose) => (sendQueued((_, queued) => sent.push(queued.text)), dispose))
  try {
    enqueue("q1", item("first"))
    enqueue("q1", item("second"))
    expect(sent).toEqual([]) // the turn is still running
    setAgents("q1", "status", "idle")
    expect(sent).toEqual(["first"])
    expect(queueOf("q1").map((queued) => queued.text)).toEqual(["second"])
    setAgents("q1", "status", "idle") // nothing new: not another send before the first one's turn runs
    expect(sent).toEqual(["first"])
    setAgents("q1", "status", "running")
    setAgents("q1", "status", "idle")
    expect(sent).toEqual(["first", "second"])
    expect(queueOf("q1")).toEqual([])
  } finally {
    dispose()
  }
})

test("a pending permission or an errored turn holds the queue", () => {
  setAgents({ q2: agent("q2", "running") })
  const sent: string[] = []
  const dispose = createRoot((dispose) => (sendQueued((_, queued) => sent.push(queued.text)), dispose))
  try {
    enqueue("q2", item("later"))
    setAgents("q2", { status: "idle", pendingPermissions: [{ id: "p" }] } as never)
    expect(sent).toEqual([])
    setAgents("q2", "pendingPermissions", [])
    expect(sent).toEqual(["later"])

    enqueue("q2", item("after the error"))
    setAgents("q2", "status", "running")
    setAgents("q2", "status", "error")
    expect(sent).toEqual(["later"])
    setAgents("q2", "status", "running")
    setAgents("q2", "status", "idle")
    expect(sent).toEqual(["later", "after the error"])
  } finally {
    dispose()
  }
})

test("queues are per session and an item can be removed before it is sent", () => {
  setAgents({ q3: agent("q3", "running"), q4: agent("q4", "running") })
  const sent: string[] = []
  const dispose = createRoot((dispose) => (sendQueued((id, queued) => sent.push(`${id}:${queued.text}`)), dispose))
  try {
    enqueue("q3", item("a"))
    enqueue("q3", item("b"))
    enqueue("q4", item("c"))
    dequeue("q3", 0)
    setAgents("q4", "status", "idle")
    expect(sent).toEqual(["q4:c"])
    setAgents("q3", "status", "idle")
    expect(sent).toEqual(["q4:c", "q3:b"])
  } finally {
    dispose()
  }
})
