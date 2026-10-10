# okan-plugins

<!-- Provenance: ~/coding/ocode/README.md conventions; Paseo-specific content authored for pasode. -->

Local terminal plugins for **paseo-tui**, the Bun 1.4.2 / OpenTUI 0.5.17 / Solid client for the Paseo daemon. Like `ocode` for OpenCode, this folder contains plugins, not live configuration or credentials.

## Install

Add the consolidated entry to `~/.config/pasode/cli.json` (preserve other settings):

```json
{
  "plugins": ["~/coding/pasode/okan-plugins"]
}
```

No install or build step. The host supplies Solid/OpenTUI at runtime. Do not register both the bundle and its individual components.

## Plugins

The host's built-in sidebar sections (Context, MCP, Todo, Modified Files, Speed/Cache/TTFT, footer) live in `../src/sidebar`; these plugins add to them.

| ID | Slot / order | Shows |
| --- | --- | --- |
| `usage-sidebar` | `sidebar_content` / 600 | Claude/Codex names left; muted reset countdown and percent used right. `3d4h` at 24h+, otherwise `3h2m`. With the ZeroSub Paseo plugin installed, lists its accounts per provider (green bullet: the account this session runs on) from a **read-only** `zerosub.state` call that never asks ZeroSub to refetch; otherwise reads Paseo's usage signal. Refreshes every 60s **while mounted**. No reading: `—`. Fable windows are omitted, expired readings show inferred `~0%`. |
| `warp` | No slot | Warp agent events for the session on screen, plus its sanitized terminal title/status (the host's `sessionTitle`, so Paseo's post-first-message rename shows). |

The session on screen speaks Warp's rich `warp://cli-agent` protocol (session start, prompt submit, permission request/reply, stop with the last query and response), so Warp shows the pane as a running/finished agent. Warp only accepts that from agents it knows by command name, so the plugin reports itself as `opencode` and `~/.warp/settings.toml` maps the `pasode` command to OpenCode (`[agents.third_party.cli_agent_toolbar_enabled_commands] '^pasode\b' = "OpenCode"`). Other sessions send nothing. "Finished" comes only from the daemon's attention flag, never from status (status flickers idle → running while a session starts); the host acknowledges that flag for the session you're looking at, like the Paseo app, so the next finish is announced again. Verified live in Warp. Sequences are emitted only when `TERM_PROGRAM` is Warp; `options.notifications === false` disables them, not titles.

## Deliberately omitted

- **visualize-context:** needs raw model requests; Paseo does not expose them.
- **model-allowlist / mcp-skill-connections:** depend on OpenCode server hooks, not Paseo's terminal plugin API.
- **sidebar-width:** `session.sidebarWidth` in the host config already controls the frame.
- **Claude accounts / Keychain / quota HTTP clients:** Paseo already supplies usage; the plugin never reads credentials or switches accounts.

## Limits / host handoff

- Background agent snapshots have status/attention/permissions, not prompt or assistant transcript text. Notifications include titles/status and permission inputs, but do not fetch all background timelines to fabricate `query` / `response` fields. All-agent transitions are observable only after the initial store snapshot; no stale startup notifications are emitted.
- Plugin setup roots are owned by the host. Plugins register Solid cleanup for slots, subscriptions and timers; unloading requires the host to dispose those roots. The current host loader does not expose unload/reload disposal.

## Verify

```sh
cd ~/coding/pasode
bun test
bun run typecheck
```

The host's `tsconfig.json` maps `@pasode/host` to `src/plugin.tsx` **for type-only imports**; the host's `bun test` and typecheck cover this folder. No npm dependencies or symlinks are added. Package paths/provenance are recorded in `SOURCES.md`.

Runtime verification must first import the host's `@opentui/solid/preload`, then call `ensureRuntimePluginSupport()` from `@opentui/solid/runtime-plugin-support/configure`, then dynamically import `okan-plugins`. `bun test` includes a child-process bundle/effect/slot-cleanup regression check. Tests do not contact providers or emit terminal notifications.
