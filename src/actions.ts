// Session actions behind the palette/slash commands (OpenCode equivalents noted per function).
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createSignal } from "solid-js"
import { copyToClipboard } from "./copy"
import { dialogs } from "./dialog"
import { pickBaseBranch } from "./git/branches"
import { locatePrompt } from "./messages"
import { agents, api, daemon, findModel, loadOlder, ownWorkspace, sessionTitle, setWorkspacePins, timeline, workspacePins, type PaseoAgent } from "./paseo"
import { current, draft, navigate, notify, prefs, setDraft, showError, subagent } from "./state"
import { toolSummary, type AgentTimelineItem } from "./timeline"

type Images = Parameters<ReturnType<typeof api.agents.ref>["send"]>[1] extends infer O ? (O extends { images?: infer I } ? I : never) : never

/** Paseo's bypass modes: Claude "Bypass", Codex "Full Access". */
export const BYPASS_MODE: Record<string, string> = { claude: "bypassPermissions", codex: "full-access" }

/**
 * OpenCode's agents mapped onto Paseo: Build runs with permissions bypassed (unless session.permissions is
 * "prompt"); Plan is Claude's plan mode or Codex's plan_mode feature.
 */
export function agentConfig(provider: string, agent: "build" | "plan") {
  if (agent === "plan") return provider === "codex" ? { modeId: BYPASS_MODE.codex, featureValues: { plan_mode: true } } : { modeId: "plan" }
  return prefs.permissions === "prompt" ? {} : { modeId: BYPASS_MODE[provider] }
}

export function agentOf(agent: { provider: string; currentModeId?: string | null; features?: { id: string; type: string; value?: unknown }[] }) {
  const plan = agent.provider === "codex" ? agent.features?.some((feature) => feature.id === "plan_mode" && feature.value === true) : agent.currentModeId === "plan"
  return plan ? "plan" : "build"
}

/** shift+tab on a live session: Build ⇄ Plan. */
export async function cycleAgent(agent: PaseoAgent) {
  const next = agentOf(agent) === "plan" ? "build" : "plan"
  if (agent.provider === "codex") return daemon.setAgentFeature(agent.id, "plan_mode", next === "plan")
  return daemon.setAgentMode(agent.id, next === "plan" ? "plan" : (agentConfig(agent.provider, "build").modeId ?? "default"))
}

/** New session from the draft (provider/model/effort/agent; fork context or worktree if set). */
export async function createSession(text: string, images?: Images, messageId?: string) {
  const { provider, fork, worktree, profile } = draft()
  const modes = { ...agentConfig(provider, draft().agent ?? "build"), ...(draft().agent !== "plan" && profile?.provider === provider ? profile.config : {}) }
  const models = draft().model ? [] : ((await api.providers.listModels(provider)).models ?? [])
  const model = draft().model ?? (models.find((m) => m.isDefault) ?? models[0])?.id
  if (!model) throw new Error(`No ${provider} models available on the daemon`)
  // Send the variant the prompt shows: without one the daemon leaves effort unset (provider default), not its catalog default.
  const thinking = draft().thinking ?? (models.find((m) => m.id === model) ?? findModel(provider, model))?.defaultThinkingOptionId ?? undefined
  const cwd = fork?.cwd ?? draft().cwd ?? process.cwd()
  const attachments = fork ? [fork.attachment] : undefined
  let id: string
  if (worktree) {
    // shortcut: workspace creation takes no clientMessageId, so the first message's image chips aren't linked.
    const created = await daemon.createWorkspace({
      source: { kind: "worktree", cwd, action: "branch-off", ...(worktree.branch ? { branchName: worktree.branch } : {}), ...(worktree.base ? { refName: worktree.base } : {}) },
      agent: { config: { provider, model, cwd, ...modes, ...(thinking ? { thinkingOptionId: thinking } : {}) }, initialPrompt: text, images, attachments },
    })
    if (!created.agent) throw new Error(created.error ?? "The worktree was created but its session wasn't")
    id = created.agent.id
  } else {
    const handle = await api.agents.create({
      config: { provider: `${provider}/${model}`, ...modes, ...(thinking ? { thinkingOptionId: thinking } : {}) },
      cwd,
      prompt: text,
      clientMessageId: messageId,
      images,
      attachments,
    })
    id = handle.id
  }
  setDraft({ ...draft(), fork: undefined, worktree: undefined, agent: undefined, cwd: undefined, profile: undefined })
  return id
}

/** OSC 52 works over SSH/tmux too; the host clipboard (pbcopy, wl-copy, xclip, xsel) covers terminals that ignore it. */
export const copyText = copyToClipboard

export async function copyLastResponse() {
  const last = timeline.rows.findLast((row) => row.type === "assistant_message")
  if (!last || last.type !== "assistant_message") return notify("No response to copy yet", "warning")
  await copyText(last.text.trim()).catch(showError)
  notify("Copied last response", "success")
}

export function transcriptMarkdown(agent: { title?: string | null; provider: string; model?: string | null; cwd: string }, rows: AgentTimelineItem[]) {
  const lines = [`# ${agent.title || "Untitled"}`, "", `${agent.provider}${agent.model ? ` · ${agent.model}` : ""} · ${agent.cwd}`, ""]
  for (const row of rows) {
    if (row.type === "user_message") lines.push("## User", "", row.text.trim(), "")
    else if (row.type === "assistant_message") lines.push("## Assistant", "", row.text.trim(), "")
    else if (row.type === "reasoning") lines.push(`> _Thinking:_ ${row.text.trim().replace(/\n/g, "\n> ")}`, "")
    else if (row.type === "tool_call") {
      const { icon, text } = toolSummary(row)
      lines.push(`- \`${icon} ${text}\`${row.status === "failed" ? " (failed)" : ""}`)
    } else if (row.type === "todo") lines.push(...row.items.map((item) => `- [${item.completed ? "x" : " "}] ${item.text}`), "")
    else if (row.type === "error") lines.push(`> **Error:** ${row.message}`, "")
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n")
}

/** OpenCode's /export: whole history (pages older entries in first) to a markdown file. */
export async function exportTranscript() {
  const agent = current()
  if (!agent) return
  const file = await dialogs.prompt({
    title: "Export transcript",
    description: "Markdown file, relative to the session directory",
    value: `session-${agent.id.slice(0, 8)}.md`,
  })
  if (!file) return
  try {
    while (timeline.agentId === agent.id && timeline.hasOlder && (await loadOlder()));
    if (timeline.agentId !== agent.id || current()?.id !== agent.id || timeline.hasOlder || timeline.loading) {
      throw new Error("Session history changed during export; try again")
    }
    const target = path.resolve(agent.cwd, file)
    await writeFile(target, transcriptMarkdown({ ...agent, title: sessionTitle(agent) }, timeline.rows))
    notify(`Exported to ${target}`, "success")
  } catch (error) {
    showError(error)
  }
}

/** OpenCode's session rename → Paseo's updateAgent({ name }), plus the workspace title a lone session shows. */
export async function rename(id = current()?.id, value?: string) {
  const agent = id ? agents[id] : undefined
  if (!agent) return
  const name = value ?? await dialogs.prompt({ title: "Rename session", value: sessionTitle(agent) ?? "" })
  if (!name?.trim()) return
  const workspace = ownWorkspace(agent)
  await Promise.all([daemon.updateAgent(agent.id, { name: name.trim() }), workspace && daemon.setWorkspaceTitle(workspace, name.trim())])
    .then(() => notify("Renamed", "success"), showError)
}

/** Paseo has no compact RPC: Claude gets `/compact` as a command, Codex maps it to thread/compact/start. */
export async function compact() {
  const agent = current()
  if (!agent) return
  await api.agents
    .ref(agent.id)
    .send("/compact")
    .then(() => notify("Compacting…"), showError)
}

// Undone prompts per session, newest last; Paseo has no redo RPC, so redo resends one.
const undone = new Map<string, string[]>()
const [undoRevision, setUndoRevision] = createSignal(0)

type UserRow = Extract<AgentTimelineItem, { type: "user_message" }>

/** A user message as it was when chosen. Refetches rewrite loaded rows in place, so later steps trust only these plain values. */
export type Chosen = { agentId: string; messageId?: string; text: string }

export const chooseMessage = (row: UserRow): Chosen | undefined => (timeline.agentId ? { agentId: timeline.agentId, messageId: row.messageId, text: row.text } : undefined)

/** Where the chosen message sits in the open timeline now (-1: another session is open, or it's gone). */
export const locateMessage = (chosen: Chosen) =>
  timeline.agentId === chosen.agentId ? timeline.rows.findLastIndex((row) => row.type === "user_message" && row.messageId === chosen.messageId && row.text === chosen.text) : -1

export const gone = () => notify("That message is no longer in the session", "warning")

/** Rewinding takes the provider's own support: Claude conversation + files, Codex conversation only. */
const rewindMode = (agent: PaseoAgent) => (agent.capabilities?.supportsRewindBoth ? "both" : agent.capabilities?.supportsRewindConversation ? "conversation" : undefined)

/** Why rewinding to this message isn't possible, if it isn't. */
export function revertBlocker(agent: PaseoAgent, message: { messageId?: string }) {
  if (!rewindMode(agent)) return `${agent.provider} sessions can't rewind`
  if (!message.messageId) return "The provider hasn't acknowledged this message yet"
}

/** Rewinds to before the chosen message (and its file edits where the provider can); its text goes back to the prompt. */
async function rewindTo(agent: PaseoAgent, chosen: Chosen, restore: (text: string) => void) {
  const index = locateMessage(chosen)
  if (index < 0 || agent.id !== chosen.agentId || current()?.id !== agent.id) return gone()
  const blocker = revertBlocker(agent, chosen)
  if (blocker) return notify(blocker, "warning")
  const mode = rewindMode(agent)!
  // Read before rewinding: the daemon's replacement reloads the timeline under us.
  const texts = timeline.rows.slice(index).flatMap((row) => (row.type === "user_message" ? [row.text] : []))
  const result = await daemon.rewindAgent(agent.id, chosen.messageId!, mode).catch((error) => ({ ok: false, error: String(error) }))
  if (!result.ok) return showError(result.error ?? "Rewind failed")
  // Newest last, so redo resends the earliest undone message first.
  undone.set(agent.id, [...(undone.get(agent.id) ?? []), ...texts.toReversed()])
  setUndoRevision((value) => value + 1)
  restore(chosen.text)
  const what = texts.length === 1 ? "the last message" : `${texts.length} messages`
  notify(mode === "both" ? `Undid ${what} and ${texts.length === 1 ? "its" : "their"} file changes` : `Undid ${what} (files unchanged)`, "success")
}

/** OpenCode's undo: rewind to before the last user message, text back in the prompt. */
export async function undo(restore: (text: string) => void) {
  const agent = current()
  const row = timeline.rows.findLast((item): item is UserRow => item.type === "user_message" && !!item.messageId)
  if (!agent) return
  if (!row) return notify("Nothing to undo", "warning")
  await rewindTo(agent, chooseMessage(row)!, restore)
}

/** OpenCode's message-actions Revert: everything from that user message on goes, after a confirmation (it can roll files back). */
export async function revertTo(chosen: Chosen, restore: (text: string) => void) {
  const agent = current()
  const index = locateMessage(chosen)
  if (!agent || agent.id !== chosen.agentId || index < 0) return gone()
  const count = timeline.rows.slice(index).filter((item) => item.type === "user_message").length
  const files = rewindMode(agent) === "both" ? " and roll back their file edits" : ""
  const ok = await dialogs.confirm("Revert to here", `Rewind ${count} message${count === 1 ? "" : "s"}${files}? Paseo can't restore the replies afterwards.`, "Revert")
  // The session or its rows may have changed while the confirmation was up: rewindTo finds the message again, or stops.
  if (ok && current()?.id === agent.id) await rewindTo(agent, chosen, restore)
}

export const canRedo = () => (undoRevision(), !!undone.get(current()?.id ?? "")?.length)

export async function redo() {
  const agent = current()
  const text = agent && undone.get(agent.id)?.pop()
  if (!agent || !text) return
  setUndoRevision((value) => value + 1)
  await api.agents
    .ref(agent.id)
    .send(text)
    .then(() => notify("Resent the undone message (Paseo can't restore the old reply)"), showError)
}

/**
 * The cursor of the last row before a user message (null: it's the first). The daemon takes only assistant message ids
 * as fork boundaries, so stopping before a prompt means finding its timeline position and the row ahead of it.
 */
async function cursorBefore(chosen: Chosen) {
  const { epoch, prompts } = await daemon.listAgentTimelinePrompts(chosen.agentId)
  const index = locateMessage(chosen)
  if (index < 0) throw new Error("That message is no longer in the session")
  const prompt = locatePrompt(prompts, timeline.rows, timeline.times, index)
  if (!prompt) throw new Error("The daemon doesn't know that message")
  const page = await daemon.fetchAgentTimeline(chosen.agentId, { direction: "before", cursor: { epoch, seq: prompt.seq }, limit: 1, projection: "projected" })
  if (page.reset) throw new Error("History changed; try again")
  const last = page.entries.at(-1)
  return last ? { epoch: page.epoch, seq: last.seqEnd } : null
}

/**
 * Like the Paseo app's fork: carry a chat-history summary into a new session; the next prompt starts it. From a user
 * message (OpenCode's Fork), the history stops before it and the message goes back in the prompt.
 */
export async function fork(from?: { chosen: Chosen; restore: (text: string) => void }) {
  const agent = current()
  if (!agent) return
  if (from && locateMessage(from.chosen) < 0) return gone()
  try {
    const boundaryCursor = from ? await cursorBefore(from.chosen) : undefined
    // Nothing precedes the first message: a plain new session in the same directory.
    const context = boundaryCursor === null ? undefined : await daemon.buildAgentForkContext(agent.id, boundaryCursor ? { boundaryCursor } : undefined)
    if (boundaryCursor !== null && !context?.attachment) throw new Error("Fork failed")
    if (current()?.id !== agent.id) return
    const title = sessionTitle(agent) || "Untitled"
    setDraft({
      provider: agent.provider,
      model: agent.model ?? undefined,
      label: agent.model ?? undefined,
      thinking: agent.thinkingOptionId ?? undefined,
      cwd: context ? undefined : agent.cwd,
      fork: context?.attachment ? { title, cwd: agent.cwd, attachment: context.attachment } : undefined,
    })
    navigate(undefined)
    from?.restore(from.chosen.text)
    notify(`Forking "${title}" — your next message starts the new session`)
  } catch (error) {
    showError(error)
  }
}

/** Paseo deep link (paseo://h/<server>/agent/<id>) — opens the session in the Paseo apps you're signed into. */
export async function share() {
  const agent = current()
  const serverId = daemon.getLastServerInfoMessage()?.serverId
  if (!agent || !serverId) return
  await copyText(`paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`)
  notify("Copied Paseo link (opens the session in the Paseo app; it doesn't publish anything)", "success")
}

/** Child sessions: Paseo child agents (labelled with their parent) and provider-native subagents (read-only). */
export const hasParent = () => !!subagent() || !!current()?.labels?.["paseo.parent-agent-id"]

export function openParent() {
  const view = subagent()
  const parent = view?.parentId ?? current()?.labels?.["paseo.parent-agent-id"]
  if (parent) navigate(parent)
}

/** Pins or unpins a session's workspace (synced with the Paseo app); only a session alone in its workspace has one of its own. */
export async function pin(id: string) {
  const agent = agents[id]
  const workspace = agent && ownWorkspace(agent)
  if (!workspace) return notify("Only a session alone in its workspace can be pinned", "warning")
  const pinned = !workspacePins[workspace]
  await daemon.setWorkspacePinned(workspace, pinned).then(({ pinnedAt }) => (setWorkspacePins(workspace, pinnedAt), notify(pinned ? "Pinned" : "Unpinned", "success")), showError)
}

/** OpenCode's session.child.next/previous: cycles the Paseo child agents of this session's parent (or of this session). */
export function cycleChild(delta: 1 | -1) {
  const agent = current()
  if (!agent) return
  const parent = agent.labels?.["paseo.parent-agent-id"] ?? agent.id
  const children = Object.values(agents)
    .filter((child) => child.labels?.["paseo.parent-agent-id"] === parent)
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  if (!children.length) return notify("No child sessions", "warning")
  const at = children.findIndex((child) => child.id === agent.id)
  // From the parent itself: next enters the first child, previous the last.
  navigate(children[at < 0 ? (delta > 0 ? 0 : children.length - 1) : (at + delta + children.length) % children.length]!.id)
}

export async function copyId() {
  const agent = current()
  if (!agent) return
  await copyText(agent.id).then(() => notify(`Copied session ID ${agent.id}`, "success"), showError)
}

/** Next new session starts in a fresh git worktree branched from the current directory's repo. */
export async function newWorktreeDraft() {
  const branch = await dialogs.prompt({ title: "New session in a git worktree", description: "Branch name (empty = generated)", placeholder: "feature/…" })
  if (branch === undefined) return
  // Enter on the first row keeps the repository's default base branch.
  const base = await pickBaseBranch(draft().cwd ?? process.cwd())
  if (base === undefined) return
  setDraft({ ...draft(), worktree: { branch: branch.trim() || undefined, base: base || undefined } })
  navigate(undefined)
  notify(`Next session starts in a new worktree of ${process.cwd()}${base ? ` (from ${base})` : ""}`)
}
