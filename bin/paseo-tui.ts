#!/usr/bin/env bun
// 1. Register the Solid JSX transform + browser-build resolution (bunfig.toml preloads only apply in this repo's cwd).
// 2. Then (dynamically, so its own `solid-js` import resolves through step 1) map solid-js/@opentui imports from
//    plugins (custom-plugins/ or any path in cli.json) onto this app's copies.
import "@opentui/solid/preload"

const { ensureRuntimePluginSupport } = await import("@opentui/solid/runtime-plugin-support/configure")
ensureRuntimePluginSupport()

await import("../src/index.tsx")
