import { afterEach, expect, jest, spyOn, test } from "bun:test"
import { mcpHealth } from "./mcp"
import { setMcpRevision } from "./paseo"

let spawn: ReturnType<typeof spyOn<typeof Bun, "spawn">>
afterEach(() => {
  jest.useRealTimers()
  spawn.mockRestore()
})

test("`claude mcp list` is reused per provider and directory for a minute, and by an MCP toggle only once it bumps mcpRevision", async () => {
  jest.useFakeTimers({ now: new Date("2026-10-21T10:00:00Z") })
  spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("cua: cmd - ✔ Connected\n").body, kill() {} })) as never)
  const first = mcpHealth("claude", "/a")
  expect(mcpHealth("claude", "/a")).toBe(first) // still running: shared
  expect(await first).toEqual({ cua: "connected" })
  await mcpHealth("claude", "/a")
  expect(spawn).toHaveBeenCalledTimes(1)

  await mcpHealth("claude", "/b")
  expect(spawn).toHaveBeenCalledTimes(2)
  await mcpHealth("codex", "/a")
  expect(spawn).toHaveBeenCalledTimes(2) // Codex has no health check, nothing spawned

  setMcpRevision((revision) => revision + 1)
  await mcpHealth("claude", "/a")
  expect(spawn).toHaveBeenCalledTimes(3)

  jest.setSystemTime(new Date("2026-10-21T10:01:01Z"))
  await mcpHealth("claude", "/a")
  expect(spawn).toHaveBeenCalledTimes(4)
})
