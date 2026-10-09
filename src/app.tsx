import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types"
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import os from "node:os"
import path from "node:path"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import * as actions from "./actions"
import { commandBindings, commands, isEnabled, keybindLabel, leader, registerCommands, runCommand, type Command } from "./commands"
import { configPath } from "./config"
import { dialog, DialogHost, dialogs, DialogSelect, type SelectOption } from "./dialog"
import { createKeymap } from "./keys"
import { claudeConfigFile, codexConfigFile, listMcpServers, setMcpEnabled } from "./mcp"
import { agents, api, daemon, loadOlder, PROVIDERS, setMcpRevision, timeline, type PaseoAgent } from "./paseo"
import { loadedPlugins, loadPlugins, Slot } from "./plugin"
import { Prompt, type PromptRef, type PromptSubmit } from "./prompt"
import { PermissionPrompt, Spinner, SplitBorder, TimelineRow } from "./session"
import { Sidebar } from "./sidebar"
import { agentId, current, draft, navigate, notify, prefs, rememberDraft, setPref, showError, subagent, toast } from "./state"
import { applyTheme, theme } from "./theme"
import { listThemes, loadTheme } from "./themes"
import { collapseForkContext, dayCategory, truncateLine } from "./timeline"

const active = (agent: PaseoAgent) => agent.status === "running" || !!agent.pendingPermissions?.length
const home = os.homedir()
const tilde = (value: string) => value.replace(home, "~")

export function App(props: { initialAgentId?: string }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  let prompt: PromptRef | undefined
  let scroll: ScrollBoxRenderable | undefined
  const [pending, setPending] = createSignal(false)
  const [escHint, setEscHint] = createSignal(false)
  /** Output of `!` shell commands, sent as context with the next message. */
  const [shellContext, setShellContext] = createSignal<string[]>([])

  // Theme from kv/config; the built-in palette stays if it can't load.
  loadTheme(prefs.theme, prefs.themeMode).then(applyTheme, () => {})
  void loadPlugins(renderer)

  // Accept the short ID prefixes `paseo ls` prints.
  const initial = props.initialAgentId
  if (initial) navigate(Object.keys(agents).find((id) => id.startsWith(initial)) ?? initial)

  const permission = createMemo(() => current()?.pendingPermissions?.[0])
  const running = () => current()?.status === "running"
  // OpenCode's session.sidebar "auto": shown on wide terminals unless toggled.
  const sidebarVisible = () => !!current() && (prefs.sidebar === "show" || (prefs.sidebar === "auto" && dimensions().width >= 120))
  const exit = () => renderer.destroy()

  const builtins: Command[] = [
    { id: "command.palette", title: "Commands", category: "System", keybind: "ctrl+p", hidden: true, run: openPalette },
    { id: "session.list", title: "Switch session", category: "Session", keybind: "<leader>l", slash: "sessions", run: openSessions },
    { id: "session.new", title: "New session", category: "Session", keybind: "<leader>n", slash: "new", run: () => navigate(undefined) },
    { id: "session.new.worktree", title: "New session in a git worktree", category: "Session", slash: "worktree", run: () => actions.newWorktreeDraft() },
    { id: "session.interrupt", title: "Interrupt session", category: "Session", keybind: "esc esc", enabled: running, run: interrupt },
    { id: "session.rename", title: "Rename session", category: "Session", slash: "rename", enabled: () => !!current(), run: () => actions.rename() },
    { id: "session.compact", title: "Compact session", category: "Session", keybind: "<leader>c", slash: "compact", enabled: () => !!current(), run: () => actions.compact() },
    { id: "session.undo", title: "Undo last message", category: "Session", keybind: "<leader>u", slash: "undo", enabled: () => !!current(), run: () => actions.undo((text) => prompt?.setText(text)) },
    { id: "session.redo", title: "Redo undone message", category: "Session", keybind: "<leader>r", slash: "redo", enabled: actions.canRedo, run: () => actions.redo() },
    { id: "session.fork", title: "Fork session", category: "Session", slash: "fork", enabled: () => !!current(), run: () => actions.fork() },
    { id: "session.share", title: "Copy session link", category: "Session", slash: "share", enabled: () => !!current(), run: () => actions.share() },
    { id: "session.export", title: "Export transcript", category: "Session", keybind: "<leader>x", slash: "export", enabled: () => !!current(), run: () => actions.exportTranscript() },
    { id: "session.timeline", title: "Jump to message", category: "Session", keybind: "<leader>g", slash: "timeline", enabled: () => !!current(), run: openTimelineDialog },
    { id: "session.copy", title: "Copy last response", category: "Session", keybind: "<leader>y", slash: "copy", enabled: () => !!current(), run: () => actions.copyLastResponse() },
    { id: "session.children", title: "Subagent sessions", category: "Session", keybind: "<leader>down", slash: "subagents", enabled: () => !!current(), run: () => actions.openChildren() },
    { id: "session.parent", title: "Go to parent session", category: "Session", keybind: "<leader>up", enabled: actions.hasParent, run: () => actions.openParent() },
    { id: "session.older", title: "Load older messages", category: "Session", slash: "older", enabled: () => timeline.hasOlder, run: () => void loadOlder().catch(showError) },
    { id: "session.reload", title: "Reload session", category: "Session", slash: "reload", enabled: () => !!current(), run: () => reload(agentId()!) },
    { id: "session.archive", title: "Archive session", category: "Session", slash: "archive", enabled: () => !!current(), run: archiveCurrent },
    { id: "messages.page_up", title: "Page up", category: "Navigation", keybind: "pageup", hidden: true, run: pageUp },
    { id: "messages.page_down", title: "Page down", category: "Navigation", keybind: "pagedown", hidden: true, run: () => scroll?.scrollBy(scroll.height - 2) },
    { id: "messages.first", title: "First message", category: "Navigation", keybind: "ctrl+g", run: () => scroll?.scrollTo(0) },
    { id: "messages.last", title: "Last message", category: "Navigation", keybind: "ctrl+alt+g", run: () => scroll?.scrollTo(scroll.scrollHeight) },
    { id: "messages.previous", title: "Previous message", category: "Navigation", keybind: "<leader>[", run: () => jumpMessage(-1) },
    { id: "messages.next", title: "Next message", category: "Navigation", keybind: "<leader>]", run: () => jumpMessage(1) },
    { id: "model.list", title: "Switch model", category: "Agent", keybind: "<leader>m", slash: "models", run: openModels },
    { id: "model.effort", title: "Thinking effort", category: "Agent", keybind: "ctrl+t", slash: "effort", run: openEffort },
    { id: "agent.fast", title: "Toggle fast mode", category: "Agent", slash: "fast", enabled: () => !!fastFeature(), run: toggleFast },
    { id: "mode.list", title: "Switch mode", category: "Agent", slash: "mode", enabled: () => !!current()?.availableModes?.length, run: openModes },
    { id: "agent.cycle", title: "Next mode", category: "Agent", keybind: "tab", hidden: true, run: () => cycleMode(1) },
    { id: "agent.cycle.reverse", title: "Previous mode", category: "Agent", keybind: "shift+tab", hidden: true, run: () => cycleMode(-1) },
    { id: "mcp.list", title: "MCP servers", category: "Agent", keybind: "<leader>s", slash: "mcp", run: openMcp },
    { id: "session.sidebar.toggle", title: "Toggle sidebar", category: "View", keybind: "<leader>b", slash: "sidebar", run: () => setPref("sidebar", sidebarVisible() ? "hide" : "show") },
    { id: "session.thinking", title: "Cycle thinking: show / collapsed / hide", category: "View", slash: "thinking", run: cycleThinking },
    { id: "session.details", title: "Toggle tool details", category: "View", keybind: "<leader>d", slash: "details", run: () => setPref("details", !prefs.details) },
    { id: "session.timestamps", title: "Toggle timestamps", category: "View", slash: "timestamps", run: () => setPref("timestamps", !prefs.timestamps) },
    { id: "session.diffs", title: "Cycle diff style: auto / unified / split", category: "View", slash: "diffs", run: cycleDiffs },
    { id: "theme.list", title: "Switch theme", category: "View", keybind: "<leader>t", slash: "themes", run: openThemes },
    { id: "editor.open", title: "Open prompt in $EDITOR", category: "Prompt", keybind: "<leader>e", slash: "editor", run: () => void prompt?.openEditor() },
    { id: "help.show", title: "Help", category: "System", keybind: "<leader>h", slash: "help", run: openHelp },
    { id: "status.show", title: "Status", category: "System", slash: "status", run: openStatus },
    { id: "app.exit", title: "Exit", category: "System", keybind: "<leader>q", slash: "exit", run: exit },
  ]
  registerCommands(builtins)
  const keymap = createKeymap(commandBindings)

  function openPalette() {
    const options = commands()
      .filter((command) => !command.hidden && isEnabled(command))
      .map((command) => ({ title: command.title, category: command.category, footer: keybindLabel(command), value: command.id }))
    dialog.replace(() => (
      <DialogSelect
        title="Commands"
        options={options}
        onSelect={(option) => {
          dialog.clear()
          runCommand(option.value)
        }}
      />
    ))
  }

  function openHelp() {
    const options = commands()
      .toSorted((a, b) => a.category.localeCompare(b.category))
      .map((command) => ({
        title: command.title,
        category: command.category,
        description: [command.id, command.slash && `/${command.slash}`].filter(Boolean).join(" · "),
        footer: keybindLabel(command) ?? "",
        value: command.id,
      }))
    dialog.replace(
      () => (
        <DialogSelect
          title={`Keybinds · leader ${leader} · ${tilde(configPath)}`}
          options={options}
          onSelect={(option) => {
            dialog.clear()
            runCommand(option.value)
          }}
        />
      ),
      "large",
    )
  }

  async function openStatus() {
    const info = daemon.getLastServerInfoMessage()
    const [snapshot, status] = await Promise.all([api.providers.snapshot().catch(() => undefined), daemon.getDaemonStatus().catch(() => undefined)])
    const providers = (snapshot?.entries ?? [])
      .filter((entry) => PROVIDERS.includes(entry.provider as (typeof PROVIDERS)[number]))
      .map((entry) => `  ${entry.provider}: ${entry.status}${entry.error ? ` (${entry.error})` : ""}`)
    const plugins = loadedPlugins.map((plugin) => `  ${plugin.id}${plugin.error ? ` ✕ ${plugin.error}` : ""}`)
    const rtt = daemon.getLastLivenessRttMs()
    await dialogs.alert(
      "Status",
      [
        `Daemon     ${info?.hostname ?? "?"} · Paseo ${status?.version ?? info?.version ?? "?"} · ${daemon.getConnectionState().status}${rtt ? ` · ${rtt}ms` : ""}`,
        `Listen     ${status?.listen ?? "?"} · pid ${status?.pid ?? "?"}${status?.relay?.enabled ? ` · relay ${status.relay.endpoint}` : " · relay off"}`,
        `Config     ${tilde(configPath)}`,
        `Theme      ${prefs.theme} (${prefs.themeMode})`,
        `Providers\n${providers.join("\n") || "  —"}`,
        `Plugins\n${plugins.join("\n") || "  none"}`,
        `MCP config claude ${tilde(claudeConfigFile())} · codex ${tilde(codexConfigFile())}`,
      ].join("\n"),
      "large",
    )
  }

  async function openThemes() {
    const themes = await listThemes().catch((error) => (showError(error), []))
    const original = prefs.theme
    let chosen = false
    const preview = (name: string) => loadTheme(name, prefs.themeMode).then(applyTheme, showError)
    dialog.replace(
      () => (
        <DialogSelect
          title="Themes"
          current={original}
          options={themes.map((item) => ({ title: item.name, value: item.name, footer: item.source }))}
          onMove={(option) => void preview(option.value)}
          onSelect={(option) => {
            chosen = true
            setPref("theme", option.value)
            dialog.clear()
          }}
        />
      ),
      "medium",
      () => !chosen && void preview(original),
    )
  }

  function openSessions() {
    dialog.replace(() => <SessionList />, "large")
  }

  function SessionList() {
    const [confirm, setConfirm] = createSignal<string>()
    const options = createMemo(() =>
      Object.values(agents)
        .toSorted((a, b) => Number(active(b)) - Number(active(a)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map(
          (agent): SelectOption<string> => ({
            title: confirm() === agent.id ? "Press ctrl+d again to archive" : agent.title || "Untitled",
            bg: confirm() === agent.id ? theme.error : undefined,
            value: agent.id,
            category: active(agent) ? "Running" : dayCategory(agent.updatedAt),
            footer: `${agent.provider} · ${path.basename(agent.cwd)}`,
            gutter:
              agent.status === "running"
                ? () => <Spinner color={theme.primary} />
                : agent.pendingPermissions?.length
                  ? () => <text fg={theme.warning}>△</text>
                  : agent.status === "error"
                    ? () => <text fg={theme.error}>✕</text>
                    : undefined,
          }),
        ),
    )
    return (
      <DialogSelect
        title="Sessions"
        emptyText="No sessions on the daemon yet"
        options={options()}
        current={agentId()}
        onMove={() => setConfirm(undefined)}
        onSelect={(option) => {
          dialog.clear()
          navigate(option.value)
        }}
        actions={[
          {
            label: "ctrl+r",
            title: "rename",
            match: (key) => key.ctrl && key.name === "r",
            run: (option) => void actions.rename(option.value),
          },
          {
            label: "ctrl+d",
            title: "archive",
            match: (key) => key.ctrl && key.name === "d",
            run: (option) => {
              if (confirm() !== option.value) return setConfirm(option.value)
              setConfirm(undefined)
              api.agents
                .ref(option.value)
                .archive()
                .then(() => agentId() === option.value && navigate(undefined))
                .catch(showError)
            },
          },
        ]}
      />
    )
  }

  function openTimelineDialog() {
    const options = timeline.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.type === "user_message")
      .map(({ row, index }) => ({
        title: truncateLine(row.type === "user_message" ? collapseForkContext(row.text) : "", 70),
        value: index,
        footer: timeline.times[index] ? new Date(timeline.times[index]!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
      }))
      .reverse()
    dialog.replace(
      () => (
        <DialogSelect
          title="Jump to message"
          emptyText="No messages yet"
          options={options}
          onSelect={(option) => {
            dialog.clear()
            scrollToRow(option.value)
          }}
        />
      ),
      "large",
    )
  }

  let messageCursor: number | undefined
  function scrollToRow(index: number) {
    messageCursor = index
    setTimeout(() => scroll?.scrollChildIntoView(`row-${index}`), 0)
  }
  function jumpMessage(delta: number) {
    const users = timeline.rows.flatMap((row, index) => (row.type === "user_message" ? [index] : []))
    if (!users.length) return
    const at = messageCursor === undefined ? users.length : users.indexOf(messageCursor)
    const next = users[Math.max(0, Math.min(users.length - 1, (at < 0 ? users.length : at) + delta))]!
    scrollToRow(next)
  }
  function pageUp() {
    if (!scroll) return
    if (scroll.scrollTop <= 0 && timeline.hasOlder) return void loadOlder().catch(showError)
    scroll.scrollBy(-(scroll.height - 2))
  }

  async function openModels() {
    const agent = current()
    const providers = agent ? [agent.provider] : [...PROVIDERS]
    const results = await Promise.all(providers.map((provider) => api.providers.listModels(provider))).catch(showError)
    if (!results) return
    const options = results.flatMap((result) =>
      (result.models ?? []).map((model) => ({
        title: model.label,
        value: `${result.provider}/${model.id}`,
        category: result.provider,
        description: model.isDefault ? "default" : undefined,
      })),
    )
    const selected = agent ? `${agent.provider}/${agent.model ?? agent.runtimeInfo?.model}` : `${draft().provider}/${draft().model}`
    dialog.replace(() => (
      <DialogSelect
        title="Select model"
        options={options}
        current={selected}
        onSelect={(option) => {
          dialog.clear()
          const [provider, model] = option.value.split("/") as [string, string]
          if (agent) daemon.setAgentModel(agent.id, model).catch(showError)
          else rememberDraft({ ...draft(), provider, model, label: option.title, thinking: undefined })
        }}
      />
    ))
  }

  /** OpenCode's variant picker: the model's thinking options (Paseo thinkingOptionId). */
  async function openEffort() {
    const agent = current()
    const provider = agent?.provider ?? draft().provider
    const modelId = agent ? (agent.model ?? agent.runtimeInfo?.model) : draft().model
    const result = await api.providers.listModels(provider).catch(showError)
    const model = result && ((result.models ?? []).find((item) => item.id === modelId) ?? (result.models ?? []).find((item) => item.isDefault))
    const options = model?.thinkingOptions ?? []
    if (!options.length) return notify(`${model?.label ?? provider} has no thinking options`, "warning")
    const selected = agent ? (agent.thinkingOptionId ?? agent.effectiveThinkingOptionId ?? undefined) : (draft().thinking ?? model?.defaultThinkingOptionId ?? undefined)
    dialog.replace(() => (
      <DialogSelect
        title={`Thinking effort · ${model?.label}`}
        current={selected}
        options={options.map((option) => ({ title: option.label, value: option.id, description: option.isDefault ? "default" : undefined }))}
        onSelect={(option) => {
          dialog.clear()
          if (agent) daemon.setAgentThinkingOption(agent.id, option.value).then((notice) => notice && notify(notice.message)).catch(showError)
          else rememberDraft({ ...draft(), model: model?.id, label: model?.label, thinking: option.value })
        }}
      />
    ))
  }

  const fastFeature = () => current()?.features?.find((feature) => feature.id === "fast_mode" && feature.type === "toggle")
  function toggleFast() {
    const agent = current()
    const feature = fastFeature()
    if (!agent || !feature || feature.type !== "toggle") return
    daemon
      .setAgentFeature(agent.id, feature.id, !feature.value)
      .then(() => notify(`Fast mode ${feature.value ? "off" : "on"}`))
      .catch(showError)
  }

  function openModes() {
    const agent = current()
    if (!agent?.availableModes?.length) return
    dialog.replace(() => (
      <DialogSelect
        title="Select mode"
        options={agent.availableModes.map((mode) => ({ title: mode.label, value: mode.id, description: mode.description ?? undefined }))}
        current={agent.currentModeId ?? undefined}
        onSelect={(option) => {
          dialog.clear()
          setMode(agent.id, option.value)
        }}
      />
    ))
  }

  function cycleMode(delta: number) {
    const agent = current()
    const modes = agent?.availableModes
    if (!agent || !modes?.length) return
    const index = modes.findIndex((mode) => mode.id === agent.currentModeId)
    setMode(agent.id, modes[(index + delta + modes.length) % modes.length]!.id)
  }

  function setMode(id: string, modeId: string) {
    daemon
      .setAgentMode(id, modeId)
      .then((notice) => notice && notify(notice.message))
      .catch(showError)
  }

  function cycleThinking() {
    const order = ["show", "collapsed", "hide"] as const
    const next = order[(order.indexOf(prefs.thinking) + 1) % order.length]!
    setPref("thinking", next)
    notify(`Thinking: ${next}`)
  }

  function cycleDiffs() {
    const order = ["auto", "unified", "split"] as const
    const next = order[(order.indexOf(prefs.diffs) + 1) % order.length]!
    setPref("diffs", next)
    notify(`Diffs: ${next}`)
  }

  function openMcp() {
    const agent = current()
    const provider = agent?.provider ?? draft().provider
    const cwd = agent?.cwd ?? process.cwd()
    let changed = false
    dialog.replace(
      () => <McpList provider={provider} cwd={cwd} onToggle={() => (changed = true)} />,
      "medium",
      // Providers read MCP config at session start, so reload once the list closes.
      () => changed && agent && reload(agent.id, true),
    )
  }

  function McpList(props: { provider: string; cwd: string; onToggle: () => void }) {
    const [servers, { mutate }] = createResource(() => listMcpServers(props.provider, props.cwd))
    const file = props.provider === "claude" ? claudeConfigFile() : codexConfigFile()
    return (
      <Show
        when={servers()}
        fallback={
          <box paddingLeft={4} paddingBottom={1}>
            <Spinner>Reading MCP config…</Spinner>
          </box>
        }
      >
        {(list) => (
          <DialogSelect
            title={`MCP servers · ${props.provider}`}
            emptyText={`No MCP servers in ${tilde(file)}`}
            options={list().map((server) => ({
              title: server.name,
              value: server.name,
              description: server.scope,
              footer: server.enabled ? "enabled" : "disabled",
              gutter: () => <text fg={server.enabled ? theme.success : theme.textMuted}>{server.enabled ? "●" : "○"}</text>,
            }))}
            onSelect={(option) => {
              const server = list().find((item) => item.name === option.value)!
              setMcpEnabled(props.provider, props.cwd, server.name, !server.enabled)
                .then(() => {
                  props.onToggle()
                  mutate(list().map((item) => (item === server ? { ...item, enabled: !item.enabled } : item)))
                  setMcpRevision((value) => value + 1)
                })
                .catch(showError)
            }}
          />
        )}
      </Show>
    )
  }

  /** Paseo's refresh restarts the provider session (resuming history), interrupting any running turn. */
  function reload(id: string, afterMcp = false) {
    if (afterMcp && agents[id]?.status === "running")
      return notify("MCP change saved; run /reload after this turn to apply it (reloading now would interrupt)", "warning")
    daemon
      .refreshAgent(id)
      .then(() => {
        notify(afterMcp ? "Session reloaded with the new MCP settings" : "Session reloaded", "success")
        if (agentId() === id) navigate(id)
      })
      .catch(showError)
  }

  let escAt = 0
  function interrupt() {
    const agent = current()
    if (agent?.status === "running") daemon.cancelAgent(agent.id).catch(showError)
  }
  function onEscape() {
    if (!running()) return false
    if (Date.now() - escAt < 1500) {
      escAt = 0
      setEscHint(false)
      interrupt()
      return true
    }
    escAt = Date.now()
    setEscHint(true)
    setTimeout(() => setEscHint(false), 1500)
    return true
  }

  function archiveCurrent() {
    const agent = current()
    if (!agent) return
    api.agents
      .ref(agent.id)
      .archive()
      .then(() => navigate(undefined))
      .catch(showError)
  }

  async function submit(input: PromptSubmit) {
    const agent = current()
    const cwd = agent?.cwd ?? process.cwd()
    if (input.mode === "shell") {
      const output = await actions.runShell(input.text, cwd)
      setShellContext((list) => [...list, output])
      return notify("Shell output will be sent with your next message")
    }
    const context = shellContext()
    const text = context.length ? `${context.join("\n\n")}\n\n${input.text}` : input.text
    setShellContext([])
    const images = input.images.length ? input.images : undefined
    try {
      if (agent) {
        // Mid-turn messages steer the running turn; the daemon would interrupt it otherwise.
        await api.agents.ref(agent.id).send(text, { images, ...(agent.status === "running" ? { activeTurnBehavior: "steer" as const } : {}) })
        return
      }
      navigate(await actions.createSession(text, images))
    } catch (error) {
      prompt?.setText(input.text)
      setShellContext(context)
      showError(error)
    }
  }

  function respond(response: AgentPermissionResponse) {
    const agent = current()
    const request = permission()
    if (!agent || !request) return
    api.agents.ref(agent.id).respondToPermission({ requestId: request.id, response }).catch(showError)
  }

  // Provider slash commands and skills for the "/" menu, fetched once per session.
  const [agentCommands] = createResource(agentId, (id) =>
    api.agents
      .ref(id)
      .commands()
      .then(({ commands }) => commands.map((command) => ({ name: command.name.replace(/^\//, ""), description: command.description })))
      .catch(() => []),
  )
  const slashItems = createMemo(() => {
    const local = commands()
      .filter((command) => command.slash && isEnabled(command))
      .map((command) => ({ name: command.slash!, description: command.title, run: () => command.run() }))
    // Ours win on name clashes (e.g. /compact), so each name is listed once.
    const remote = agentId() ? (agentCommands() ?? []).filter((command) => !local.some((item) => item.name === command.name)) : []
    return [...local, ...remote]
  })

  useKeyboard((key: KeyEvent) => {
    if (dialog.isOpen || key.defaultPrevented) return
    const handled = (() => {
      if (!keymap.pending && prompt?.handleKey(key)) return true
      if (key.ctrl && key.name === "c") {
        keymap.reset()
        setPending(false)
        if (!prompt?.isEmpty()) return prompt?.clear(), true
        return exit(), true
      }
      // The permission prompt owns plain keys (arrows, tab, enter, esc) while it is up.
      if (permission() && !keymap.pending && !key.ctrl && !key.meta) return false
      if (key.name === "escape" && !keymap.pending && onEscape()) return true
      const result = keymap.feed(key)
      setPending(result === "pending")
      if (result === "pending") {
        setTimeout(() => {
          if (keymap.pending) {
            keymap.reset()
            setPending(false)
          }
        }, 2000)
        return true
      }
      if (result) return runCommand(result), true
      return false
    })()
    if (handled) key.preventDefault()
  })

  const header = createMemo(() => {
    const agent = current()
    if (!agent) return undefined
    const usage = agent.lastUsage
    const tokens = usage?.contextWindowUsedTokens
    const percent = tokens && usage?.contextWindowMaxTokens ? ` (${Math.round((tokens / usage.contextWindowMaxTokens) * 100)}%)` : ""
    const cost = usage?.totalCostUsd ? ` · $${usage.totalCostUsd.toFixed(2)}` : ""
    return { title: agent.title || "Untitled", stats: tokens ? `${tokens.toLocaleString()}${percent}${cost}` : "" }
  })

  const modeLabel = () => {
    const agent = current()
    return agent?.availableModes?.find((mode) => mode.id === agent.currentModeId)?.label ?? agent?.currentModeId ?? (draft().fork ? `Fork of ${draft().fork!.title}` : draft().worktree ? "New · worktree" : "New")
  }
  const modelLabel = () => {
    const agent = current()
    const model = agent ? (agent.runtimeInfo?.model ?? agent.model ?? "") : (draft().label ?? draft().model ?? "default model")
    const effort = agent ? (agent.thinkingOptionId ?? agent.effectiveThinkingOptionId) : draft().thinking
    const fast = fastFeature()
    return [model, effort, fast?.type === "toggle" && fast.value ? "fast" : undefined].filter(Boolean).join(" · ")
  }
  const cwd = () => tilde(current()?.cwd ?? process.cwd())

  const PromptBox = () => (
    <Prompt
      ref={(ref) => (prompt = ref)}
      focused={!dialog.isOpen && !permission()}
      placeholder={current() ? "Send a message…" : `Start a new ${draft().provider} session in ${cwd()}…`}
      cwd={current()?.cwd ?? process.cwd()}
      slashItems={slashItems()}
      onSubmit={(input) => void submit(input)}
      footer={
        <box flexDirection="row" gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            {modeLabel()}
          </text>
          <text fg={theme.text}>{modelLabel()}</text>
          <text fg={theme.textMuted}>{current()?.provider ?? draft().provider}</text>
          <Show when={shellContext().length}>
            <text fg={theme.warning}>+{shellContext().length} shell output</text>
          </Show>
        </box>
      }
    />
  )

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} flexDirection="row">
      <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
        <Show
          when={agentId()}
          fallback={
            <box flexGrow={1} justifyContent="center" alignItems="center" gap={1}>
              <ascii_font text="paseo" font="tiny" color={theme.text} />
              <text fg={theme.textMuted}>
                {Object.keys(agents).length} sessions on the daemon · {keybindLabel(builtins[1]!)} to open one · ctrl+p commands
              </text>
              <box width={Math.min(80, dimensions().width - 4)} paddingTop={1}>
                <PromptBox />
              </box>
              <Slot name="home_bottom" />
            </box>
          }
        >
          <Slot name="session_header" agent={current()}>
            <Show when={!sidebarVisible() && header()}>
              {(info) => (
                <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingLeft={1}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    # {info().title}
                  </text>
                  <text fg={theme.textMuted}>{info().stats}</text>
                </box>
              )}
            </Show>
          </Slot>
          <scrollbox ref={(r: ScrollBoxRenderable) => (scroll = r)} flexGrow={1} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
            <Show when={timeline.loading}>
              <box paddingLeft={3}>
                <Spinner>Loading session…</Spinner>
              </box>
            </Show>
            <Show when={timeline.hasOlder}>
              <box paddingLeft={3} onMouseUp={() => void loadOlder().catch(showError)}>
                <text fg={theme.textMuted}>↑ older messages · pageup at the top or /older</text>
              </box>
            </Show>
            <For each={timeline.rows}>
              {(item, index) => (
                <box id={`row-${index()}`} flexShrink={0}>
                  <TimelineRow
                    item={item}
                    previous={timeline.rows[index() - 1]}
                    streaming={running() && index() === timeline.rows.length - 1}
                    showThinking={prefs.thinking !== "hide"}
                    thinking={prefs.thinking}
                    showDetails={prefs.details}
                    timestamp={timeline.times[index()]}
                    showTimestamps={prefs.timestamps}
                    diffStyle={prefs.diffs}
                  />
                </box>
              )}
            </For>
          </scrollbox>
          <Show
            when={permission()}
            fallback={
              <Show when={subagent()} fallback={<PromptBox />}>
                {(view) => (
                  <box border={["left"]} borderColor={theme.secondary} customBorderChars={SplitBorder} flexShrink={0}>
                    <box paddingLeft={2} paddingTop={1} paddingBottom={1} backgroundColor={theme.backgroundPanel}>
                      <text fg={theme.textMuted}>
                        <span style={{ fg: theme.text }}>↳ {view().title}</span> · read-only subagent of {current()?.title || "this session"} ·{" "}
                        {keybindLabel(builtins.find((command) => command.id === "session.parent")!)} back
                      </text>
                    </box>
                  </box>
                )}
              </Show>
            }
          >
            {(request) => <PermissionPrompt request={request()} onRespond={respond} />}
          </Show>
        </Show>
        <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <box flexDirection="row" gap={2}>
            <Show when={running()} fallback={<text fg={theme.textMuted}>{cwd()}</text>}>
              <Spinner color={theme.primary}>{escHint() ? "esc again to interrupt" : "working · esc esc to interrupt"}</Spinner>
            </Show>
          </box>
          <text fg={theme.textMuted}>
            <Show when={pending()} fallback={<>ctrl+p commands · {leader} h help</>}>
              <span style={{ fg: theme.primary }}>{leader}</span> l sessions · n new · m model · s mcp · t themes · h help
            </Show>
          </text>
        </box>
      </box>
      <Show when={sidebarVisible() && current()}>{(agent) => <Sidebar agent={agent()} />}</Show>
      <Show when={toast()}>
        {(t) => (
          <box
            position="absolute"
            top={1}
            right={2}
            zIndex={4000}
            maxWidth={60}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={theme.backgroundPanel}
            border={["left"]}
            customBorderChars={SplitBorder}
            borderColor={t().variant === "error" ? theme.error : t().variant === "warning" ? theme.warning : t().variant === "success" ? theme.success : theme.primary}
          >
            <Show when={t().title}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {t().title}
              </text>
            </Show>
            <text fg={theme.text}>{t().message}</text>
          </box>
        )}
      </Show>
      <DialogHost />
    </box>
  )
}
