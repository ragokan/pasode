// MCP on/off lives in each provider's own config, not in Paseo (it has no MCP RPC).
// Claude: projects[<cwd>].disabledMcpServers in .claude.json, the same list `claude` /mcp edits.
// Codex: `enabled = false` under [mcp_servers.<name>] in config.toml (global).
import { readFileSync } from "node:fs"
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type McpServer = { name: string; scope: "user" | "local" | "project" | "global"; enabled: boolean }

/** Env Paseo launches a provider with, e.g. Claude's CLAUDE_CONFIG_DIR. */
function providerEnv(provider: string): Record<string, string> {
  const home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo")
  try {
    return JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).agents?.providers?.[provider]?.env ?? {}
  } catch {
    return {}
  }
}

export function claudeConfigFile() {
  const dir = providerEnv("claude").CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  return dir ? path.join(dir.replace(/^~/, os.homedir()), ".claude.json") : path.join(os.homedir(), ".claude.json")
}

export function codexConfigFile() {
  const home = providerEnv("codex").CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  return path.join(home.replace(/^~/, os.homedir()), "config.toml")
}

export async function listMcpServers(provider: string, cwd: string): Promise<McpServer[]> {
  if (provider === "claude") return listClaudeMcp(claudeConfigFile(), cwd)
  if (provider === "codex") return listCodexMcp(await readFile(codexConfigFile(), "utf8").catch(() => ""))
  return []
}

export type McpHealth = "connected" | "failed" | "needs_auth"

/**
 * Live status as the current model's CLI sees it: `claude mcp list` health-checks every server with the env
 * Paseo launches Claude with. Codex has no health check, so its enabled servers stay "configured".
 */
export async function mcpHealth(provider: string, cwd: string): Promise<Record<string, McpHealth>> {
  if (provider !== "claude") return {}
  try {
    const child = Bun.spawn(["claude", "mcp", "list"], { cwd, env: { ...process.env, ...providerEnv("claude") }, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => child.kill(), 30_000)
    const text = await new Response(child.stdout).text()
    clearTimeout(timer)
    return parseClaudeMcpList(text)
  } catch {
    return {}
  }
}

/** OpenCode's home-footer counts over the enabled servers; with no health check (Codex) enabled counts as connected. */
export function mcpCounts(servers: McpServer[], health: Record<string, McpHealth>, checked: boolean) {
  const enabled = servers.filter((server) => server.enabled)
  const state = (name: string) => health[name] ?? (checked ? undefined : "connected")
  return {
    total: enabled.length,
    connected: enabled.filter((server) => state(server.name) === "connected").length,
    failed: enabled.filter((server) => state(server.name) === "failed").length,
  }
}

/** Lines look like `cua: /path/cua-driver mcp --direct - ✔ Connected` or `x: https://… (HTTP) - ✗ Failed to connect`. */
export function parseClaudeMcpList(text: string) {
  const health: Record<string, McpHealth> = {}
  for (const line of text.split("\n")) {
    const match = line.match(/^([^\s:][^:]*): .* - ([✔✓✗✘⚠!])\s*(.*)$/)
    if (!match) continue
    health[match[1]!.trim()] = match[2] === "✔" || match[2] === "✓" ? "connected" : /auth/i.test(match[3]!) ? "needs_auth" : "failed"
  }
  return health
}

export async function setMcpEnabled(provider: string, cwd: string, name: string, enabled: boolean) {
  if (provider === "claude") return setClaudeMcp(claudeConfigFile(), cwd, name, enabled)
  if (provider === "codex") {
    const file = codexConfigFile()
    const { mode } = await stat(file)
    return writeAtomic(file, setTomlEnabled(await readFile(file, "utf8"), name, enabled), mode)
  }
  throw new Error(`MCP toggling is not supported for ${provider}`)
}

export async function listClaudeMcp(file: string, cwd: string): Promise<McpServer[]> {
  const config = await readJson(file)
  const project = config.projects?.[cwd] ?? {}
  const projectJson = await readJson(path.join(cwd, ".mcp.json"))
  const disabled = new Set<string>(project.disabledMcpServers ?? [])
  const servers = new Map<string, McpServer>()
  // Claude's precedence: local beats project beats user.
  const scopes = [
    ["local", project.mcpServers],
    ["project", projectJson.mcpServers],
    ["user", config.mcpServers],
  ] as const
  for (const [scope, defs] of scopes)
    for (const name of Object.keys(defs ?? {}))
      if (!servers.has(name)) servers.set(name, { name, scope, enabled: !disabled.has(name) })
  return [...servers.values()]
}

export async function setClaudeMcp(file: string, cwd: string, name: string, enabled: boolean) {
  await locked(file, async () => {
    const { mode } = await stat(file).catch(() => ({ mode: 0o600 }))
    const config = await readJson(file)
    const project = ((config.projects ??= {})[cwd] ??= {})
    const disabled = new Set<string>(project.disabledMcpServers ?? [])
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    project.disabledMcpServers = [...disabled]
    // Claude Code writes this file as 2-space JSON without a trailing newline.
    await writeAtomic(file, JSON.stringify(config, null, 2), mode)
  })
}

export function listCodexMcp(toml: string): McpServer[] {
  const servers = ((toml ? Bun.TOML.parse(toml) : {}) as { mcp_servers?: Record<string, { enabled?: boolean }> }).mcp_servers ?? {}
  return Object.entries(servers).map(([name, server]) => ({ name, scope: "global", enabled: server.enabled !== false }))
}

/** Line edit so comments and formatting in config.toml survive. */
export function setTomlEnabled(toml: string, name: string, enabled: boolean) {
  const lines = toml.split("\n")
  const start = lines.findIndex((line) => {
    const match = line.match(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([\w-]+))\s*\]\s*(#.*)?$/)
    return (match?.[1] ?? match?.[2]) === name
  })
  if (start < 0) throw new Error(`No [mcp_servers.${name}] table in config.toml`)
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line))
  if (end < 0) end = lines.length
  const existing = lines.findIndex((line, index) => index > start && index < end && /^\s*enabled\s*=/.test(line))
  if (existing >= 0) lines[existing] = `enabled = ${enabled}`
  else lines.splice(start + 1, 0, `enabled = ${enabled}`)
  return lines.join("\n")
}

async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}

async function writeAtomic(file: string, text: string, mode: number) {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, text, { mode })
  await rename(temp, file)
}

// Claude Code guards its config with a proper-lockfile directory lock (10s stale); take the same one.
// Forked from ~/coding/ocode/plugins/usage-sidebar/accounts.ts.
async function locked(file: string, task: () => Promise<void>) {
  const lock = `${file}.lock`
  for (let tries = 0; ; tries++) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const { mtimeMs } = await stat(lock).catch(() => ({ mtimeMs: 0 }))
      if (Date.now() - mtimeMs > 10_000) {
        await rmdir(lock).catch(() => {})
        continue
      }
      if (tries >= 50) throw new Error(`Claude Code is holding ${file}; try again`)
      await Bun.sleep(100)
    }
  }
  try {
    await task()
  } finally {
    await rmdir(lock).catch(() => {})
  }
}
