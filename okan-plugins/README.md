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

The host's existing title stays first. Sidebar sections use OpenCode-style bold headers, muted values and success/muted bullets; MCP, Todo and Modified Files collapse on header click when there are more than two entries.

| ID | Slot / order | Shows |
| --- | --- | --- |
| `sidebar-context` | `sidebar_content` / 100 | Latest context tokens, percent used and cost from `agent.lastUsage`. Explicit context occupancy wins; fallback token accounting respects Claude/Codex cache semantics. Missing readings are `—`, not invented zeroes. |
| `sidebar-mcp` | `sidebar_content` / 200 | Provider-config MCP names, Enabled/Disabled, reread after `mcpRevision` changes. Enabled is **not** a claim that the server is connected. |
| `sidebar-todo` | `sidebar_content` / 400 | Latest `todo` timeline item; hidden when all tasks are complete. |
| `sidebar-files` | `sidebar_content` / 500 | Completed edit/write calls aggregated by cwd-relative path, with `+added` / `-removed` counts. |
| `usage-sidebar` | `sidebar_content` / 600 | Claude/Codex names left; muted reset countdown and percent used right. `3d4h` at 24h+, otherwise `3h2m`. Reads Paseo's usage signal and refreshes every 60s **while mounted**. No reading: `—`. Fable windows are omitted, expired readings show inferred `~0%`. |
| `token-metrics` | `sidebar_content` / 700 | Speed, Cache, TTFT using the host's former metrics logic. Speed excludes recorded tool time and needs live turn completion/token events; historical messages can supply TTFT. |
| `sidebar-footer` | `sidebar_footer` / 100, single winner | `• Paseo <daemon version> <connection status>`, using daemon server info and connection subscriptions. |
| `warp` | No slot | Warp agent events for the session on screen, plus its sanitized terminal title/status (the host's `sessionTitle`, so Paseo's post-first-message rename shows). |

The session on screen speaks Warp's rich `warp://cli-agent` protocol (session start, prompt submit, permission request/reply, stop with the last query and response), so Warp shows the pane as a running/finished agent. Warp only accepts that from agents it knows by command name, so the plugin reports itself as `opencode` and `~/.warp/settings.toml` maps the `pasode` command to OpenCode (`[agents.third_party.cli_agent_toolbar_enabled_commands] '^pasode\b' = "OpenCode"`). Other sessions send nothing. "Finished" comes only from the daemon's attention flag, never from status (status flickers idle → running while a session starts); the host acknowledges that flag for the session you're looking at, like the Paseo app, so the next finish is announced again. Verified live in Warp. Sequences are emitted only when `TERM_PROGRAM` is Warp; `options.notifications === false` disables them, not titles.

## Deliberately omitted

- **visualize-context:** needs raw model requests; Paseo does not expose them.
- **model-allowlist / mcp-skill-connections:** depend on OpenCode server hooks, not Paseo's terminal plugin API.
- **sidebar-width:** `session.sidebarWidth` in the host config already controls the frame.
- **Claude accounts / Keychain / quota HTTP clients:** Paseo already supplies usage; the plugin never reads credentials or switches accounts.

## Limits / host handoff

- Modified Files is **timeline activity**, not a Git working-tree diff. The host exposes only its newest 300 rows. Repeated edits accumulate; unified diff counts are preferred, otherwise edit old/new replacement strings are counted. Writes expose new content but no old content, so removed lines cannot be calculated. Shell/unknown tools that modify files are not represented as edit/write details.
- Cost is exactly `lastUsage.totalCostUsd`, not an independently calculated lifetime session total. Missing daemon version/context limit/cost stays `—`.
- Speed/TTFT logic moved here from the host's former `src/metrics.ts`; the host must retain structurally compatible `timeline.marks` and turn marks. Parallel tool overlap behavior remains the original implementation: recorded tool durations are summed.
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

Initial verification: 19 Bun tests and sibling-dependency typechecking pass. A separate runtime-loader script imports all eight plugins. A real OpenTUI test renderer at 30 columns verifies all section text/layout, MCP collapse/revision refresh, current title changes, completed-todo hiding, daemon version/connection changes and subscription cleanup against fake Paseo data. Live daemon rendering and session navigation through the host remain unverified here; Warp toasts were later verified live.
