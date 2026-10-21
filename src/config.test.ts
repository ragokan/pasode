import { expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

test.each(['{"prefs": {"theme": "mono', "", "null", "3", "true", '"text"', "[]", '["bad"]'])("an invalid kv.json (%j) falls back to writable defaults", (contents) => {
  const state = mkdtempSync(path.join(os.tmpdir(), "pasode-kv-"))
  try {
    mkdirSync(path.join(state, "pasode"))
    const file = path.join(state, "pasode", "kv.json")
    writeFileSync(file, contents)
    const run = Bun.spawnSync(["bun", "-e", `
      const assert = (await import("node:assert/strict")).default
      const { kvGet, kvSet } = await import(${JSON.stringify(path.join(import.meta.dir, "config.ts"))})
      assert.deepEqual(kvGet("prefs", {}), {})
      assert.equal(kvGet("0", "fallback"), "fallback")
      kvSet("prefs", { theme: "mono" })
      assert.deepEqual(kvGet("prefs", {}), { theme: "mono" })
    `], { env: { ...process.env, XDG_STATE_HOME: state } })
    expect(run.stderr.toString()).toBe("")
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ prefs: { theme: "mono" } })
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test("a valid kv.json retains its saved preferences", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "pasode-kv-"))
  try {
    mkdirSync(path.join(state, "pasode"))
    writeFileSync(path.join(state, "pasode", "kv.json"), '{"prefs": {"theme": "saved"}}')
    const run = Bun.spawnSync(["bun", "-e", `const { kvGet } = await import(${JSON.stringify(path.join(import.meta.dir, "config.ts"))}); console.log(JSON.stringify(kvGet("prefs", {})))`], {
      env: { ...process.env, XDG_STATE_HOME: state },
    })
    expect(run.stderr.toString()).toBe("")
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout.toString())).toEqual({ theme: "saved" })
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test.each(['"./mine"', '{"a": 1}', "3", "true"])("a non-array plugins value (%s) is one reported error instead of a throw", (value) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pasode-cfg-"))
  try {
    writeFileSync(path.join(dir, "cli.json"), `{"plugins": ${value}}`)
    const run = Bun.spawnSync(["bun", "-e", `const { pluginSpecs } = await import(${JSON.stringify(path.join(import.meta.dir, "config.ts"))}); console.log(JSON.stringify(pluginSpecs().map((s) => s.error)))`], {
      env: { ...process.env, PASODE_CONFIG_DIR: dir },
    })
    expect(run.stderr.toString()).toBe("")
    expect(JSON.parse(run.stdout.toString())).toEqual(['"plugins" must be an array'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("kvSet replaces kv.json by rename: the old file is never truncated in place, and no temp file stays", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "pasode-kv-"))
  try {
    const dir = path.join(state, "pasode")
    mkdirSync(dir)
    const file = path.join(dir, "kv.json")
    writeFileSync(file, '{"prefs": {"theme": "old"}}')
    // A second name for the same inode still sees an in-place write; after a rename it keeps the old, complete file.
    linkSync(file, path.join(dir, "reader.json"))
    const run = Bun.spawnSync(["bun", "-e", `const { kvSet } = await import(${JSON.stringify(path.join(import.meta.dir, "config.ts"))}); kvSet("prefs", { theme: "new" })`], {
      env: { ...process.env, XDG_STATE_HOME: state },
    })
    expect(run.stderr.toString()).toBe("")
    expect(readFileSync(path.join(dir, "reader.json"), "utf8")).toBe('{"prefs": {"theme": "old"}}')
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ prefs: { theme: "new" } })
    expect(readdirSync(dir).sort()).toEqual(["kv.json", "reader.json"])
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test("a malformed plugins entry is reported on its own; the other entries still resolve", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pasode-cfg-"))
  writeFileSync(path.join(dir, "cli.json"), '{"plugins": [null, 3, "./mine"]}')
  const run = Bun.spawnSync(["bun", "-e", `const { pluginSpecs } = await import(${JSON.stringify(path.join(import.meta.dir, "config.ts"))}); console.log(JSON.stringify(pluginSpecs().map((s) => s.error ?? s.path)))`], {
    env: { ...process.env, PASODE_CONFIG_DIR: dir },
  })
  rmSync(dir, { recursive: true, force: true })
  expect(run.stderr.toString()).toBe("")
  expect(JSON.parse(run.stdout.toString())).toEqual(["expected a path or [path, options]", "expected a path or [path, options]", path.join(dir, "mine")])
})
