# paseo-tui

OpenCode-style terminal client for a running [Paseo](https://paseo.sh) daemon. Sessions you start, answer or
steer here are the same ones the Paseo desktop and mobile apps show, live. Claude and Codex only.

Built on OpenTUI + Solid (OpenCode's UI stack) and `@getpaseo/client`; much of the UI is ported from
OpenCode (MIT). Plugins live in [`~/coding/pascode`](../pascode).

```sh
bun install
bun bin/paseo-tui.ts            # home: new session in the current directory
bun bin/paseo-tui.ts 1c9a5b6    # open a session (full ID or `paseo ls` prefix)
```

On your PATH: `chmod +x bin/paseo-tui.ts && ln -s "$PWD/bin/paseo-tui.ts" ~/.local/bin/paseo-tui`.

Connects to `daemon.listen` from `~/.paseo/config.json` (`127.0.0.1:6767`). Env: `PASEO_URL`
(e.g. `ws://host:6767/ws`), `PASEO_PASSWORD`, `PASEO_HOME`, `PASCODE_CONFIG_DIR`.

Everything is live: sessions started from the Paseo app or your phone show up under **Running** in
`ctrl+x l`; open one to attach to its stream.

## Config: `~/.config/pascode/cli.json` (JSONC)

Same shape as OpenCode's `cli.json` where it overlaps:

```jsonc
{
  "theme": { "name": "monokai-pro-ristretto", "mode": "dark" }, // OpenCode built-ins + ~/.config/{opencode,pascode}/themes
  "leader": "ctrl+x",
  "keybinds": { "agent.cycle": "shift+tab", "session.sidebar.toggle": "ctrl+b" }, // ids: ctrl+x h; "none" disables
  "session": { "sidebar": "auto", "sidebarWidth": 42, "thinking": "show", "diffs": "auto" },
  "plugins": ["~/coding/pascode/plugins/pascode"] // or ["path", { options }]
}
```

Runtime choices (theme, toggles, last model) persist in `~/.local/state/pascode/kv.json`.

## What's there

- **Sessions**: list grouped Running / Today / date (`ctrl+d` twice archives, `ctrl+r` renames), new, worktree
  (`/worktree`), rename, `/compact`, undo (`ctrl+x u`, rewinds conversation and — on Claude — file edits; the
  message returns to the prompt), redo (resends: Paseo can't restore the old reply), fork (new session seeded with a
  chat-history summary), `/share` (copies a `paseo://` deep link), `/export` (markdown), `/copy`, subagents
  (`ctrl+x down`: Paseo child agents, or provider subagents read-only; `ctrl+x up` back), reload, archive, older
  history (pageup at the top, `/older`).
- **Navigation**: jump to message (`ctrl+x g`), previous/next message (`ctrl+x [` / `]`), first/last, page up/down.
- **Prompt**: `/` commands (ours plus the session's own commands and skills), `@` file mentions, ↑/↓ history,
  `!` shell mode (runs locally; output goes with your next message), image paste, `$EDITOR` (`ctrl+x e`),
  mid-turn messages steer the turn.
- **Agent**: model, thinking effort (`ctrl+t`), fast mode, mode (`shift+tab`/`tab`), MCP servers (`ctrl+x s`).
- **Rendering**: OpenCode's tool blocks, colored unified/split diffs, highlighted writes, collapsible thinking,
  timestamps, permission / plan / question prompts (with free-text "Other…").
- **View/System**: theme switcher with live preview (`ctrl+x t`), sidebar (`ctrl+b`), help with every keybind id
  (`ctrl+x h`), `/status` (daemon, providers, plugins).

Not possible through Paseo (no API): LSP/diagnostics, live MCP connection health, true redo (old replies can't be
restored), published share pages.

## MCP

Paseo has no MCP API, so `/mcp` edits each provider's own config, the same places their CLIs use:

- Claude: `projects[<session cwd>].disabledMcpServers` in the `.claude.json` of the `CLAUDE_CONFIG_DIR`
  Paseo launches Claude with (yours: `~/.paseo/claude`). Lists user, local and `.mcp.json` servers. Per project.
- Codex: `enabled` under `[mcp_servers.<name>]` in `~/.codex/config.toml` (or Paseo's `CODEX_HOME`). Global.

Closing the list reloads the session (Paseo `refreshAgent`, history kept) so the change applies; mid-turn it waits
for `/reload`. Status shown is the configured state, not live connection health.

## Plugins

`export default { id, setup(ctx) }` (or an array), like OpenCode's TUI plugins. `ctx.ui.slot(name, render, order)`
fills `sidebar_title | sidebar_content | sidebar_footer | home_bottom | session_header`; `ctx.commands.register`,
`ctx.ui.dialog` / `toast`, `ctx.paseo` (client + live stores), `ctx.mcp`, `ctx.theme`. See `src/plugin.tsx`.
Plugins import `solid-js` / `@opentui/*` normally; the launcher maps them onto this app's copies.

## Checks

`bun test` and `bun run typecheck`.
