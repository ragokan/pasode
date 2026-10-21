# paseo-tui

OpenCode-style terminal client for a running [Paseo](https://paseo.sh) daemon. Sessions you start, answer or
steer here are the same ones the Paseo desktop and mobile apps show, live. Claude and Codex only.

Built on OpenTUI + Solid (OpenCode's UI stack) and `@getpaseo/client`; much of the UI is ported from
OpenCode (MIT). Plugins live in [`okan-plugins/`](okan-plugins).

Install a release binary (macOS or Linux, arm64 or x64). It mentions newer releases when it opens; `/update` installs
one and restarts into the same session.

```sh
mkdir -p ~/.local/bin && curl -fL "https://github.com/ragokan/pasode/releases/latest/download/pasode-$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/').gz" | gunzip > ~/.local/bin/pasode && chmod +x ~/.local/bin/pasode
```

Or run from source:

```sh
bun install
bun bin/paseo-tui.ts            # home: new session in the current directory
bun bin/paseo-tui.ts -s 1c9a5b6 # open a session (full ID or `paseo ls` prefix; `-s` optional)
```

On your PATH: `chmod +x bin/paseo-tui.ts && ln -s "$PWD/bin/paseo-tui.ts" ~/.local/bin/paseo-tui`.

Connects to `daemon.listen` from `~/.paseo/config.json` (`127.0.0.1:6767`). Env: `PASEO_URL`
(e.g. `ws://host:6767/ws`), `PASEO_PASSWORD`, `PASEO_HOME`, `PASODE_CONFIG_DIR`. Without `PASEO_URL`, if nothing
listens on that local address, pasode starts the daemon with `paseo daemon start` (Paseo.app's bundled CLI on macOS);
it keeps running after pasode exits.

Everything is live: sessions started from the Paseo app or your phone show up under **Running** in
`ctrl+x l`; open one to attach to its stream.

## Config: `~/.config/pasode/cli.json` (JSONC)

Same shape as OpenCode's `cli.json` where it overlaps:

```jsonc
{
  "theme": { "name": "monokai-pro-ristretto", "mode": "dark" }, // OpenCode's default + ~/.config/{opencode,pasode}/themes
  "leader": "ctrl+x",
  "keybinds": { "agent.cycle": "shift+tab", "session.sidebar.toggle": "ctrl+b" }, // ids: ctrl+x h; "none" disables
  "session": { "sidebar": "auto", "sidebarWidth": 30, "thinking": "show", "verbosity": "medium", "permissions": "bypass" },
  "animations": true, // false: still ⋯ instead of spinners
  "mouse": true, // false: no terminal mouse capture
  "plugins": ["~/coding/pasode/okan-plugins"] // or ["path", { options }]
}
```

Runtime choices (theme, toggles, last model) persist in `~/.local/state/pasode/kv.json`. `/settings` is OpenCode's
settings dialog (←/→ changes a value) for the ones pasode honors: theme, color mode, animations, sidebar, scrollbar,
thinking, markdown, tool grouping, verbosity, transcript images, TPS, new session location, permissions, diff layout,
mouse. "Toggle animations" is also in the command palette.
Quitting from a session prints its title and `pasode -s <id>` to continue, like OpenCode.

## What's there

- **Sessions**: list grouped Running / Today / date (`ctrl+d` twice archives, `ctrl+r` renames), new, worktree
  (`/worktree`), rename, `/compact`, undo (`ctrl+x u`, rewinds conversation and — on Claude — file edits; the
  message returns to the prompt), redo (resends: Paseo can't restore the old reply), fork (new session seeded with a
  chat-history summary), `/share` (copies a `paseo://` deep link), `/export` (markdown), `/copy`, reload, archive,
  older history (pageup at the top, `/older`). New sessions start as **Build** with permissions bypassed (Claude
  Bypass / Codex Full Access; `"permissions": "prompt"` keeps the provider default); `shift+tab` switches to Plan.
- **Composer** (`↓` on a one-line prompt, like OpenCode): Subagents tab (Paseo child agents and provider subagents,
  read-only; `ctrl+a` running/finished, `ctrl+d` interrupt) and Shell tab (Paseo terminals in the session directory:
  live output, `ctrl+d` kill). The prompt footer shows `↓ N subagents · N shells` and context usage.
- **Navigation**: jump to message (`ctrl+x g`), previous/next message (`ctrl+x [` / `]`), first/last, page up/down.
- **Prompt**: only what Paseo takes: the typed text, sent as-is, plus native image attachments (`ctrl+v` or a pasted
  image path; thumbnails above the input, click or backspace-on-empty removes). `/` completion anywhere in the text
  (ours plus the provider's commands and skills, on the home screen too; a typed `/rename <name>` is ours, so
  the Paseo title changes, not only Claude Code's own session name), `$EDITOR` (`ctrl+x e`), mid-turn messages
  steer the turn.
- **Agent**: model (`ctrl+x m`), variant cycle (`ctrl+t`; `/variants`
  lists them), fast mode, Paseo mode (`/mode`), MCP servers (`/mcps`, live Claude health).
- **Rendering**: OpenCode 2.0.26's transcript: collapsed activity groups by `verbosity`, reasoning, tool blocks,
  colored unified/split diffs, image thumbnails (sent images and images tools return), `Build · model · time · tok/s`
  turn footers, timestamps, permission / plan / question prompts (with free-text "Other…"). Like OpenCode, only the
  newest 40 transcript rows mount; scrolling up, pageup, jumps and `ctrl+g` mount older ones (60 at a time).
  Spinners run at half OpenCode's frame rate.
- **View/System**: theme switcher with live preview (`ctrl+x t`), sidebar (`ctrl+b`), help with every keybind id
  (`ctrl+x h`), `/status` (daemon, providers, plugins).

Not possible through Paseo (no API): LSP/diagnostics, Codex MCP health, true redo (old replies can't be restored),
published share pages, `@` file mentions and `!` shell mode (left out: they'd add to what Paseo sends).

## MCP

Paseo has no MCP API, so `/mcps` edits each provider's own config, the same places their CLIs use:

- Claude: `projects[<session cwd>].disabledMcpServers` in the `.claude.json` of the `CLAUDE_CONFIG_DIR`
  Paseo launches Claude with (yours: `~/.paseo/claude`). Lists user, local and `.mcp.json` servers. Per project.
- Codex: `enabled` under `[mcp_servers.<name>]` in `~/.codex/config.toml` (or Paseo's `CODEX_HOME`). Global.

Closing the list reloads the session (Paseo `refreshAgent`, history kept) so the change applies; mid-turn it waits
for `/reload`. Claude servers show live health from `claude mcp list` (run with Paseo's `CLAUDE_CONFIG_DIR`);
Codex servers show their configured state.

## Sidebar

Built-in sections live in `src/sidebar/` and register through the same slot API as plugins (like OpenCode's
feature plugins), so a plugin's `order` places it between them. The session title stays first. Sections use
OpenCode-style bold headers, muted values and success/muted bullets; MCP, Todo and Modified Files collapse on header
click when there are more than two entries.

| Folder | Slot / order | Shows |
| --- | --- | --- |
| `context` | `sidebar_content` / 100 | Latest context tokens, percent used and cost from `agent.lastUsage`. Explicit context occupancy wins; fallback token accounting respects Claude/Codex cache semantics. Missing readings are `—`, not invented zeroes. |
| `mcp` | `sidebar_content` / 200 | Provider-config MCP names, Enabled/Disabled, reread after `mcpRevision` changes. Enabled is **not** a claim that the server is connected. |
| `todo` | `sidebar_content` / 400 | Latest `todo` timeline item; hidden when all tasks are complete. |
| `files` | `sidebar_content` / 500 | Completed edit/write calls aggregated by cwd-relative path, with `+added` / `-removed` counts. |
| `metrics` | `sidebar_content` / 700 | Speed, Cache, TTFT. Speed excludes recorded tool time and needs live turn completion/token events; historical messages can supply TTFT. |
| `footer` | `sidebar_footer` / 100, single winner | `• Paseo <daemon version> <connection status>`, using daemon server info and connection subscriptions. |

- Modified Files is **timeline activity**, not a Git working-tree diff, over the newest 300 timeline rows. Repeated
  edits accumulate; unified diff counts are preferred, otherwise edit old/new replacement strings are counted. Writes
  expose no old content, so removed lines can't be counted. Shell/unknown tools that modify files are not represented.
- Cost is exactly `lastUsage.totalCostUsd`, not a lifetime session total. Missing daemon version/context limit/cost
  stays `—`.
- Speed/TTFT read `timeline.marks` and turn marks; recorded tool durations are summed (parallel tools overlap).

## Plugins

`export default { id, setup(ctx) }` (or an array), like OpenCode's TUI plugins. `ctx.ui.slot(name, render, order)`
fills `sidebar_title | sidebar_content | sidebar_footer | home_bottom | session_header`; `ctx.commands.register`,
`ctx.ui.dialog` / `toast`, `ctx.paseo` (client + live stores), `ctx.mcp`, `ctx.theme`. See `src/plugin.tsx`.
Plugins import `solid-js` / `@opentui/*` normally; the launcher maps them onto this app's copies.

## Checks

`bun test` and `bun run typecheck`.

## Releasing

Bump `version` in `package.json`, then build every platform's binary and publish them with their checksums:

```sh
bun install --frozen-lockfile --os='*' --cpu='*'
bun run build bun-darwin-arm64 bun-darwin-x64 bun-linux-arm64 bun-linux-x64
gh release create v$(bun -p 'require("./package.json").version') dist/*.gz dist/SHA256SUMS
```
