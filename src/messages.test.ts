import { expect, test } from "bun:test"
import { locatePrompt, matchedPrompts, promptKeys, promptPreview, userRowKeys, type Prompt } from "./messages"
import type { AgentTimelineItem } from "./timeline"

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem
const assistant = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem
const prompt = (seq: number, at: number, text: string): Prompt => ({ seq, timestamp: new Date(at).toISOString(), preview: promptPreview(text) })

test("previews collapse whitespace and cut at 120 characters like the daemon's", () => {
  expect(promptPreview("  a \n\n b\t c ")).toBe("a b c")
  expect(promptPreview("x".repeat(130))).toBe(`${"x".repeat(119)}…`)
})

test("loaded rows find their prompts even when texts repeat and the daemon stamped every row alike", () => {
  // History the daemon rehydrated: one timestamp for all, and the same "continue" three times.
  const all = ["start", "continue", "continue", "stop", "continue"].map((text, i) => prompt(i * 2 + 1, 1000, text))
  // Only the newest four user messages are loaded.
  const rows = [user("continue"), assistant("a"), user("continue"), assistant("b"), user("stop"), user("continue")]
  const times = rows.map(() => 1000)
  const rowKeys = userRowKeys(rows, times)
  const keys = promptKeys(all)
  expect([...rowKeys].map(([key, index]) => [index, all.indexOf([...keys].find(([, other]) => other === key)![0])])).toEqual([
    [0, 1],
    [2, 2],
    [4, 3],
    [5, 4],
  ])
  expect(locatePrompt(all, rows, times, 2)).toBe(all[2])
  expect(locatePrompt(all, rows, times, 0)).toBe(all[1])
  expect(locatePrompt(all, rows, times, 1)).toBeUndefined() // not a user message
})

test("a search hit maps to its prompt, and an assistant hit to the prompt of its turn", () => {
  const prompts = [prompt(1, 0, "a"), prompt(5, 0, "b"), prompt(9, 0, "c")]
  const hits = matchedPrompts(prompts, [
    { seq: 2, role: "assistant" },
    { seq: 5, role: "user" },
    { seq: 6, role: "assistant" },
    { seq: 10, role: "assistant" },
  ])
  expect([...hits]).toEqual([
    [1, "assistant"],
    [5, "user"],
    [9, "assistant"],
  ])
})
