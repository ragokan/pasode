import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types"
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import os from "node:os"
import path from "node:path"
import { createEffect, createMemo, createResource, createSignal, Match, Show, Switch } from "solid-js"
import pkg from "../package.json"
import * as actions from "./actions"
import { attachmentsOf, rememberImages } from "./attachments"
import { commandBindings, commands, isEnabled, keybindLabel, leader, registerCommands, runCommand, type Command } from "./commands"
import { Composer, composerOpen, handleComposerKey, runningSubagents, terminals, toggleComposer, useSubagentPolling, useTerminalPolling } from "./composer"
import { configPath } from "./config"
import { dialog, DialogHost, dialogs, DialogSelect, type SelectOption } from "./dialog"
import { footerLayout, liveLabel, usageItems } from "./footer"
import { createKeymap } from "./keys"
import { Logo } from "./logo"
import { claudeConfigFile, codexConfigFile, listMcpServers, mcpCounts, mcpHealth, setMcpEnabled, type McpHealth } from "./mcp"
import { agents, api, daemon, findModel, loadOlder, mcpRevision, modelLabel, PROVIDERS, providerName, setMcpRevision, timeline, type PaseoAgent } from "./paseo"
import { loadedPlugins, loadPlugins, Slot } from "./plugin"
import { Prompt, type PromptRef, type PromptSubmit } from "./prompt"
import { PermissionPrompt, Spinner, SplitBorder, Transcript } from "./session"
import { Sidebar } from "./sidebar"
import { agentId, current, draft, navigate, notify, prefs, rememberDraft, setDraft, setPref, showError, subagent, toast } from "./state"
import { applyTheme, theme } from "./theme"
import { listThemes, loadTheme } from "./themes"
import { collapseForkContext, dayCategory, truncateLine } from "./timeline"

const active = (agent: PaseoAgent) => agent.status === "running" || !!agent.pendingPermissions?.length
const home = os.homedir()
const tilde = (value: string) => value.replace(home, "~")

export function App(props: { initialAgentId?: string }) {
  const renderer = useRenderer()
  // Not a leak: every transcript footer and thumbnail reads the terminal size, one resize listener each.
  renderer.setMaxListeners(0)
  const dimensions = useTerminalDimensions()
  let prompt: PromptRef | undefined
  let scroll: ScrollBoxRenderable | undefined
  const [pending, setPending] = createSignal(false)
  const [escHint, setEscHint] = createSignal(false)

  // Theme from kv/config; the built-in palette stays if it can't load.
  loadTheme(prefs.theme, prefs.themeMode).then(applyTheme, () => {})
  void loadPlugins(renderer)

  // Accept the short ID prefixes `paseo ls` prints.
  const initial = props.initialAgentId
  if (initial) navigate(Object.keys(agents).find((id) => id.startsWith(initial)) ?? initial)

  // Like the Paseo app, a session you're looking at gets its finished/error flag acknowledged. The daemon raises
  // attention (and its notification) only on a false → true change, so a stale flag would swallow later finishes.
  const [terminalFocused, setTerminalFocused] = createSignal(true)
  renderer.on("focus", () => setTerminalFocused(true))
  renderer.on("blur", () => setTerminalFocused(false))
  createEffect(() => {
    const agent = current()
    if (agent?.requiresAttention && terminalFocused()) void daemon.clearAgentAttention(agent.id).catch(() => {})
  })

  const permission = createMemo(() => current()?.pendingPermissions?.[0])
  const running = () => current()?.status === "running"
  useSubagentPolling(running)
  useTerminalPolling()
  // OpenCode's session.sidebar "auto": shown on wide terminals unless toggled.
  const sidebarVisible = () => !!current() && (prefs.sidebar === "show" || (prefs.sidebar === "auto" && dimensions().width >= 120))
  const exit = () => renderer.destroy()

  const builtins: Command[] = [
    { id: "command.palette", title: "Commands", category: "System", keybind: "ctrl+p", hidden: true, run: openPalette },
    { id: "session.list", title: "Switch session", category: "Session", keybind: "<leader>l", slash: "sessions", run: openSessions },
    { id: "session.new", title: "New session", category: "Session", keybind: "<leader>n", slash: "new", run: () => navigate(undefined) },
    { id: "session.new.worktree", title: "New session in a git worktree", category: "Session", slash: "worktree", run: () => actions.newWorktreeDraft() },
    { id: "session.interrupt", title: "Interrupt session", category: "Session", keybind: "escape", enabled: running, run: interrupt },
    { id: "session.rename", title: "Rename session", category: "Session", slash: "rename", enabled: () => !!current(), run: () => actions.rename() },
    { id: "session.compact", title: "Compact session", category: "Session", keybind: "<leader>c", slash: "compact", enabled: () => !!current(), run: () => actions.compact() },
    { id: "session.undo", title: "Undo last message", category: "Session", keybind: "<leader>u", slash: "undo", enabled: () => !!current(), run: () => actions.undo((text) => prompt?.setText(text)) },
    { id: "session.redo", title: "Redo undone message", category: "Session", keybind: "<leader>r", slash: "redo", enabled: actions.canRedo, run: () => actions.redo() },
    { id: "session.fork", title: "Fork session", category: "Session", slash: "fork", enabled: () => !!current(), run: () => actions.fork() },
    { id: "session.share", title: "Copy session link", category: "Session", slash: "share", enabled: () => !!current(), run: () => actions.share() },
    { id: "session.export", title: "Export transcript", category: "Session", keybind: "<leader>x", slash: "export", enabled: () => !!current(), run: () => actions.exportTranscript() },
    { id: "session.timeline", title: "Jump to message", category: "Session", keybind: "<leader>g", slash: "timeline", enabled: () => !!current(), run: openTimelineDialog },
    { id: "session.copy", title: "Copy last response", category: "Session", keybind: "<leader>y", slash: "copy", enabled: () => !!current(), run: () => actions.copyLastResponse() },
    // OpenCode's ↓ under the prompt: only while the prompt is one line, so ↓ still moves through multi-line drafts.
    { id: "session.child.first", title: "Toggle subagent picker", category: "Session", keybind: "down", slash: "subagents", enabled: () => !!current() && !permission() && !prompt?.text().includes("\n"), run: toggleComposer },
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
    { id: "variant.cycle", title: "Cycle model variants", category: "Agent", keybind: "ctrl+t,super+t", run: cycleVariant },
    { id: "variant.list", title: "Switch model variant", category: "Agent", slash: "variants", run: openEffort },
    { id: "agent.fast", title: "Toggle fast mode", category: "Agent", slash: "fast", enabled: () => !!fastFeature(), run: toggleFast },
    { id: "mode.list", title: "Switch mode", category: "Agent", slash: "mode", enabled: () => !!current()?.availableModes?.length, run: openModes },
    { id: "agent.cycle", title: "Next agent", category: "Agent", keybind: "shift+tab", hidden: true, run: cycleAgent },
    { id: "agent.cycle.reverse", title: "Previous agent", category: "Agent", hidden: true, run: cycleAgent },
    { id: "mcp.list", title: "MCP servers", category: "Agent", keybind: "<leader>s", slash: "mcps", run: openMcp },
    { id: "session.sidebar.toggle", title: "Toggle sidebar", category: "View", keybind: "<leader>b", slash: "sidebar", run: () => setPref("sidebar", sidebarVisible() ? "hide" : "show") },
    { id: "session.thinking", title: "Toggle thinking", category: "View", slash: "thinking", run: toggleThinking },
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

  /** OpenCode's agents: Build (permissions bypassed) ⇄ Plan. */
  function cycleAgent() {
    const agent = current()
    if (agent) return void actions.cycleAgent(agent).catch(showError)
    setDraft({ ...draft(), agent: draft().agent === "plan" ? undefined : "plan" })
  }

  /** variant.cycle: step through the model's thinking options without a dialog. */
  function cycleVariant() {
    const agent = current()
    const model = findModel(agent?.provider ?? draft().provider, agent ? (agent.model ?? agent.runtimeInfo?.model) : draft().model)
    const options = model?.thinkingOptions ?? []
    if (!model || !options.length) return notify(`${model?.label ?? "This model"} has no variants`, "warning")
    const next = options[(options.findIndex((option) => option.id === modelInfo().variant) + 1) % options.length]!
    if (agent) return void daemon.setAgentThinkingOption(agent.id, next.id).catch(showError)
    rememberDraft({ ...draft(), model: model.id, label: model.label, thinking: next.id })
  }

  function setMode(id: string, modeId: string) {
    daemon
      .setAgentMode(id, modeId)
      .then((notice) => notice && notify(notice.message))
      .catch(showError)
  }

  function toggleThinking() {
    const next = prefs.thinking === "show" ? "hide" : "show"
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
    const [health] = createResource(() => mcpHealth(props.provider, props.cwd))
    const file = props.provider === "claude" ? claudeConfigFile() : codexConfigFile()
    const healthColor = { connected: theme.success, failed: theme.error, needs_auth: theme.warning } satisfies Record<McpHealth, unknown>
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
              footer: !server.enabled ? "disabled" : (health()?.[server.name]?.replace("_", " ") ?? (health.loading ? "checking…" : "enabled")),
              gutter: () => {
                const state = health()?.[server.name]
                return <text fg={!server.enabled ? theme.textMuted : state ? healthColor[state] : theme.success}>{server.enabled ? "●" : "○"}</text>
              },
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

  /** Sends exactly what was typed plus native image attachments; rejecting keeps the prompt's draft. */
  async function submit(input: PromptSubmit) {
    const agent = current()
    const images = input.images.length ? input.images : undefined
    const messageId = crypto.randomUUID()
    rememberImages(messageId, images)
    try {
      // Mid-turn messages steer the running turn; the daemon would interrupt it otherwise.
      if (agent) return await api.agents.ref(agent.id).send(input.text, { messageId, images, ...(agent.status === "running" ? { activeTurnBehavior: "steer" as const } : {}) })
      navigate(await actions.createSession(input.text, images, messageId))
    } catch (error) {
      showError(error)
      throw error
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
      if (!keymap.pending && handleComposerKey(key)) return true
      if (!keymap.pending && prompt?.handleKey(key)) return true
      if (key.ctrl && key.name === "c") {
        keymap.reset()
        setPending(false)
        if (!prompt?.isEmpty()) return prompt?.clear(), true
        return exit(), true
      }
      // OpenCode's app.exit includes ctrl+d, but only on an empty prompt (otherwise it deletes forward).
      if (key.ctrl && key.name === "d" && !keymap.pending && (prompt?.isEmpty() ?? true)) return exit(), true
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

  const agentLabel = () => ((current() ? actions.agentOf(current()!) : (draft().agent ?? "build")) === "plan" ? "Plan" : "Build")
  const modelInfo = () => {
    const agent = current()
    const provider = agent?.provider ?? draft().provider
    const id = agent ? (agent.model ?? agent.runtimeInfo?.model) : draft().model
    const variant = agent ? (agent.thinkingOptionId ?? agent.effectiveThinkingOptionId) : (draft().thinking ?? findModel(provider, id)?.defaultThinkingOptionId)
    return { name: modelLabel(provider, id), provider: providerName(provider), variant: variant ?? undefined }
  }
  const cwd = () => current()?.cwd ?? process.cwd()
  const [branch] = createResource(cwd, async (dir) => {
    try {
      const child = Bun.spawn(["git", "branch", "--show-current"], { cwd: dir, stdout: "pipe", stderr: "ignore" })
      return (await new Response(child.stdout).text()).trim()
    } catch {
      return ""
    }
  })
  const label = (id: string) => {
    const command = commands().find((item) => item.id === id)
    return command && keybindLabel(command)
  }

  // OpenCode's prompt footer (feature-plugins/prompt/footer.tsx): live subagents/shells and context usage, else shortcuts.
  const PromptFooter = () => {
    const live = () => (current() ? liveLabel(runningSubagents(), terminals().length) : undefined)
    const usage = () => usageItems(current()?.lastUsage)
    const layout = () => {
      const palette = label("command.palette")
      if (!usage().length) return { usage: false, shortcuts: dimensions().width >= 44 }
      return footerLayout(Math.max(0, dimensions().width - 8), usage(), palette ? [`${palette} commands`] : [])
    }
    return (
      <Show
        when={!pending()}
        fallback={
          <text fg={theme.textMuted} wrapMode="none">
            <span style={{ fg: theme.text }}>{leader}</span> l sessions · n new · m model · s mcp · t themes · h help
          </text>
        }
      >
        <box flexDirection="row" gap={2} flexShrink={1} minWidth={0}>
          <Switch>
            <Match when={live() || (layout().usage && usage().length)}>
              <text fg={theme.textMuted} wrapMode="none" onMouseUp={toggleComposer}>
                <Show when={live()}>
                  {(value) => (
                    <>
                      <Show when={label("session.child.first")}>{(key) => <span style={{ fg: theme.text }}>{key()} </span>}</Show>
                      {value()}
                    </>
                  )}
                </Show>
                <Show when={layout().usage && usage().length}>
                  <Show when={live()}> · </Show>
                  {usage().join(" · ")}
                </Show>
              </text>
            </Match>
            <Match when={layout().shortcuts}>
              <text fg={theme.text} flexShrink={0}>
                {label("agent.cycle")} <span style={{ fg: theme.textMuted }}>agents</span>
              </text>
            </Match>
          </Switch>
          <Show when={layout().shortcuts}>
            <text fg={theme.text} wrapMode="none" flexShrink={0}>
              {label("command.palette")} <span style={{ fg: theme.textMuted }}>commands</span>
            </text>
          </Show>
        </box>
      </Show>
    )
  }

  const PromptBox = () => (
    <Prompt
      ref={(ref) => (prompt = ref)}
      focused={!dialog.isOpen && !permission() && !subagent() && !composerOpen()}
      cwd={cwd()}
      slashItems={slashItems()}
      agent={{ label: agentLabel(), color: theme.agent }}
      model={modelInfo()}
      location={`${tilde(cwd())}${branch() ? `:${branch()}` : ""}`}
      footerRight={<PromptFooter />}
      status={{ running: running(), interruptArmed: escHint() }}
      onSubmit={submit}
    />
  )

  // OpenCode's feature-plugins/home/footer.tsx: MCP status for the current model's provider, version on the right.
  const HomeFooter = () => {
    const [mcp] = createResource(
      () => [draft().provider, mcpRevision()] as const,
      async ([provider]) => {
        const [servers, health] = await Promise.all([listMcpServers(provider, process.cwd()), mcpHealth(provider, process.cwd())])
        return mcpCounts(servers, health, provider === "claude")
      },
    )
    const counts = () => (mcp.error ? undefined : mcp())
    return (
      <Show when={dimensions().height >= 14 && dimensions().width >= 44}>
        <box width="100%" paddingTop={dimensions().height < 16 ? 0 : 1} paddingBottom={dimensions().height < 16 ? 0 : 1} paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0} gap={2}>
          <Show when={counts()?.total}>
            <box gap={1} flexDirection="row" flexShrink={0} onMouseUp={openMcp}>
              <text fg={theme.text}>
                <Show
                  when={counts()!.failed}
                  fallback={
                    <>
                      <span style={{ fg: counts()!.connected ? theme.success : theme.textMuted }}>⊙ </span>
                      {counts()!.connected} MCP
                    </>
                  }
                >
                  <span style={{ fg: theme.error }}>⊙ </span>
                  {counts()!.failed} MCP failed
                </Show>
              </text>
              <Show when={dimensions().width >= 64}>
                <text fg={theme.textMuted}>/mcps</text>
              </Show>
            </box>
          </Show>
          <Slot name="home_bottom" />
          <box flexGrow={1} />
          <Show when={dimensions().width >= 64}>
            <text fg={theme.textMuted}>{pkg.version}</text>
          </Show>
        </box>
      </Show>
    )
  }

  const padding = () => (dimensions().width < 44 ? 1 : 2)

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} flexDirection="row">
      <Show
        when={agentId()}
        fallback={
          <box flexGrow={1}>
            <box flexGrow={1} alignItems="center" paddingLeft={padding()} paddingRight={padding()}>
              <box flexGrow={1} minHeight={0} />
              <box height={3} minHeight={0} flexShrink={1} />
              <box flexShrink={0}>
                <Logo />
              </box>
              <box height={1} flexShrink={0} />
              <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1} flexShrink={0} position="relative">
                <PromptBox />
              </box>
              <box flexGrow={1} minHeight={0} />
            </box>
            <HomeFooter />
          </box>
        }
      >
        <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={padding()} paddingRight={padding()}>
          <Slot name="session_header" agent={current()} />
          <box flexGrow={1} minHeight={0} position="relative">
            <scrollbox ref={(r: ScrollBoxRenderable) => (scroll = r)} flexGrow={1} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
              <Show when={timeline.loading}>
                <box paddingLeft={3} marginTop={1}>
                  <Spinner>Loading session…</Spinner>
                </box>
              </Show>
              <Show when={timeline.hasOlder}>
                <box paddingLeft={3} marginTop={1} onMouseUp={() => void loadOlder().catch(showError)}>
                  <text fg={theme.textMuted}>↑ older messages · pageup at the top or /older</text>
                </box>
              </Show>
              <Transcript
                rows={timeline.rows}
                times={timeline.times}
                marks={timeline.marks}
                running={running()}
                agent={{ label: agentLabel(), color: theme.agent }}
                model={modelInfo().name}
                verbosity={prefs.verbosity}
                thinking={prefs.thinking}
                grouping={prefs.grouping}
                details={prefs.details}
                timestamps={prefs.timestamps}
                diffStyle={prefs.diffs}
                tps={prefs.tps}
                attachments={attachmentsOf}
              />
            </scrollbox>
          </box>
          <box height={1} flexShrink={0} />
          <box flexShrink={0}>
            <Composer />
            <Switch>
              <Match when={composerOpen()}>{null}</Match>
              <Match when={permission()}>{(request) => <PermissionPrompt request={request()} onRespond={respond} />}</Match>
              <Match when={subagent()}>
                {(view) => (
                  <box border={["left"]} borderColor={theme.secondary} customBorderChars={SplitBorder} flexShrink={0}>
                    <box paddingLeft={2} paddingTop={1} paddingBottom={1} backgroundColor={theme.backgroundPanel}>
                      <text fg={theme.textMuted}>
                        <span style={{ fg: theme.text }}>↳ {view().title}</span> · read-only subagent of {current()?.title || "this session"} · {label("session.parent")} back
                      </text>
                    </box>
                  </box>
                )}
              </Match>
            </Switch>
            {/* Kept mounted while the composer, a permission or a subagent view covers it, so the draft survives. */}
            <box visible={!composerOpen() && !permission() && !subagent()} flexShrink={0}>
              <PromptBox />
            </box>
          </box>
        </box>
      </Show>
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
