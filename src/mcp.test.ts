import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listClaudeMcp, listCodexMcp, mcpCounts, setClaudeMcp, setMcpEnabled, setTomlEnabled, parseClaudeMcpList } from "./mcp"

const root = mkdtempSync(path.join(os.tmpdir(), "paseo-tui-mcp-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("claude: lists scopes and toggles projects[cwd].disabledMcpServers in place", async () => {
  const dir = await mkdtemp(path.join(root, "dir-"))
  const file = path.join(dir, ".claude.json")
  const cwd = path.join(dir, "repo")
  const original = { oauthAccount: { email: "x" }, mcpServers: { a: {}, b: {} }, projects: { [cwd]: { mcpServers: { c: {} }, disabledMcpServers: ["b"], other: 1 } } }
  await writeFile(file, JSON.stringify(original, null, 2), { mode: 0o600 })

  expect(await listClaudeMcp(file, cwd)).toEqual([
    { name: "c", scope: "local", enabled: true },
    { name: "a", scope: "user", enabled: true },
    { name: "b", scope: "user", enabled: false },
  ])

  await setClaudeMcp(file, cwd, "a", false)
  await setClaudeMcp(file, cwd, "b", true)
  const saved = JSON.parse(await readFile(file, "utf8"))
  expect(saved.projects[cwd]).toEqual({ mcpServers: { c: {} }, disabledMcpServers: ["a"], other: 1 })
  expect(saved.oauthAccount).toEqual({ email: "x" })
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await readFile(file, "utf8")).not.toEndWith("\n")

  // A new project entry is created on demand, and a missing file is fine.
  await setClaudeMcp(file, "/elsewhere", "a", false)
  expect(JSON.parse(await readFile(file, "utf8")).projects["/elsewhere"]).toEqual({ disabledMcpServers: ["a"] })
  expect(await listClaudeMcp(path.join(dir, "missing.json"), cwd)).toEqual([])
})

test("codex: edits only the named table and keeps comments", () => {
  const toml = [
    "model = \"x\" # keep",
    "[mcp_servers.node_repl]",
    "command = \"node\"",
    "",
    "[mcp_servers.node_repl.env]",
    "A = \"1\"",
    "",
    "[mcp_servers.\"cua-driver\"]",
    "command = \"cua\"",
    "enabled = false # off",
  ].join("\n")
  expect(listCodexMcp(toml)).toEqual([
    { name: "node_repl", scope: "global", enabled: true },
    { name: "cua-driver", scope: "global", enabled: false },
  ])
  const off = setTomlEnabled(toml, "node_repl", false)
  expect(off.split("\n").slice(0, 3)).toEqual(["model = \"x\" # keep", "[mcp_servers.node_repl]", "enabled = false"])
  expect(listCodexMcp(off).map((s) => s.enabled)).toEqual([false, false])
  const on = setTomlEnabled(toml, "cua-driver", true)
  expect(on.split("\n").at(-1)).toBe("enabled = true")
  expect(() => setTomlEnabled(toml, "nope", true)).toThrow("No [mcp_servers.nope]")
})

test("parses `claude mcp list` health lines", () => {
  const sample = [
    "Checking MCP server health…",
    "",
    "cua: /Users/me/.local/bin/cua-driver mcp --direct - ✔ Connected",
    "browseros: http://127.0.0.1:9010/mcp (HTTP) - ✔ Connected",
    "linear: https://mcp.linear.app/sse (SSE) - ⚠ Needs authentication",
    "broken: npx -y thing - ✗ Failed to connect",
  ].join("\n")
  expect(parseClaudeMcpList(sample)).toEqual({ cua: "connected", browseros: "connected", linear: "needs_auth", broken: "failed" })
  expect(parseClaudeMcpList("No MCP servers configured.")).toEqual({})
})

test("home footer counts: enabled servers only; unchecked providers count enabled as connected", () => {
  const servers = [
    { name: "cua", scope: "user", enabled: true },
    { name: "browseros", scope: "user", enabled: true },
    { name: "off", scope: "user", enabled: false },
  ] as const
  expect(mcpCounts([...servers], { cua: "connected", browseros: "failed", off: "connected" }, true)).toEqual({ total: 2, connected: 1, failed: 1 })
  expect(mcpCounts([...servers], {}, false)).toEqual({ total: 2, connected: 2, failed: 0 })
})

test("toggles write through a symlinked config instead of replacing the link", async () => {
  const dir = await mkdtemp(path.join(root, "dir-"))
  const target = path.join(dir, "dotfiles.json")
  const link = path.join(dir, ".claude.json")
  await writeFile(target, JSON.stringify({ mcpServers: { a: {} } }))
  await symlink(target, link)
  await setClaudeMcp(link, "/repo", "a", false)
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(JSON.parse(await readFile(target, "utf8")).projects["/repo"].disabledMcpServers).toEqual(["a"])
  await rm(dir, { recursive: true })
})

test("codex: concurrent toggles both land", async () => {
  const dir = await mkdtemp(path.join(root, "dir-"))
  const env = { PASEO_HOME: process.env.PASEO_HOME, CODEX_HOME: process.env.CODEX_HOME }
  process.env.PASEO_HOME = dir
  process.env.CODEX_HOME = dir
  try {
    await writeFile(path.join(dir, "config.toml"), "[mcp_servers.a]\ncommand = \"a\"\n\n[mcp_servers.b]\ncommand = \"b\"\n")
    await Promise.all([setMcpEnabled("codex", dir, "a", false), setMcpEnabled("codex", dir, "b", false)])
    expect(listCodexMcp(await readFile(path.join(dir, "config.toml"), "utf8")).map((server) => server.enabled)).toEqual([false, false])
  } finally {
    await rm(dir, { recursive: true })
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
