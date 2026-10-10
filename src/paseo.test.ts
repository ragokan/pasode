import { expect, test } from "bun:test"
import { createRoot, createEffect } from "solid-js"
import { agents, sessionTitle, setAgents, setWorkspaceTitles, type PaseoAgent } from "./paseo"

const agent = (id: string, workspaceId: string, title: string) => ({ id, workspaceId, title }) as PaseoAgent

test("a lone session shows its workspace's generated title, live; shared workspaces keep agent titles", () => {
  setAgents({ a: agent("a", "w", "Lets update our packages to latest bun") })
  setWorkspaceTitles({ w: "Lets update our packages to latest bun" })
  const seen: (string | null | undefined)[] = []
  createRoot(() => createEffect(() => seen.push(sessionTitle(agents.a!))))
  // Paseo's auto-name after the first message only rewrites the workspace title.
  setWorkspaceTitles("w", "Upgrade Bun to 1.4.3")
  expect(seen).toEqual(["Lets update our packages to latest bun", "Upgrade Bun to 1.4.3"])
  setWorkspaceTitles("w", null)
  expect(sessionTitle(agents.a!)).toBe("Lets update our packages to latest bun")
  setWorkspaceTitles("w", "Shared workspace")
  setAgents("b", agent("b", "w", "Child task"))
  expect([sessionTitle(agents.a!), sessionTitle(agents.b!)]).toEqual(["Lets update our packages to latest bun", "Child task"])
})
