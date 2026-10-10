// Provenance: pasode-authored OpenTUI runtime-loader regression check; bundle convention from ocode/plugins/ocode.
import { expect, test } from "bun:test"
import path from "node:path"

test("host runtime loads the bundle, binds Solid effects, and disposes slot registrations", () => {
  const host = path.resolve(import.meta.dir, "..")
  const entry = path.join(import.meta.dir, "index.ts")
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", `
      const assert = (await import("node:assert/strict")).default
      const host = ${JSON.stringify(host)}
      await import(Bun.resolveSync("@opentui/solid/preload", host))
      const { ensureRuntimePluginSupport } = await import(Bun.resolveSync("@opentui/solid/runtime-plugin-support/configure", host))
      ensureRuntimePluginSupport()
      const { default: plugins } = await import(${JSON.stringify(entry)})
      const { createRoot } = await import("opentui:runtime-module:solid-js")
      const slots = []
      const titles = []
      const stops = []
      assert.equal(plugins.length, 2)
      assert.equal(new Set(plugins.map(plugin => plugin.id)).size, 2)
      for (const plugin of plugins) {
        assert.equal(typeof plugin.id, "string")
        assert.equal(typeof plugin.setup, "function")
        createRoot(stop => {
          stops.push(stop)
          plugin.setup({
            options: { notifications: false },
            paseo: { current: () => ({ title: "Fixture", status: "running", pendingPermissions: [] }), sessionTitle: agent => agent.title },
            renderer: { setTerminalTitle: title => titles.push(title) },
            ui: { slot: (name, view, order) => {
              const entry = { name, view, order }
              slots.push(entry)
              return () => slots.splice(slots.indexOf(entry), 1)
            } },
          })
        })
      }
      assert.deepEqual(slots.filter(slot => slot.name === "sidebar_content").map(slot => slot.order), [600])
      assert.deepEqual(titles, ["• Fixture"])
      for (const stop of stops) stop()
      assert.equal(slots.length, 0)
    `],
    cwd: host,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
}, 15_000)
