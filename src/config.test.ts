import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
