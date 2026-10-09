// Session actions behind the palette/slash commands (OpenCode equivalents noted per function).
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createSignal } from "solid-js"
import { produce } from "solid-js/store"
import { dialogs } from "./dialog"
import { agents, api, daemon, loadOlder, openSubagentTimeline, setTimeline, timeline } from "./paseo"
import { current, draft, navigate, notify, setDraft, setSubagent, showError, subagent } from "./state"
import { toolSummary, type AgentTimelineItem } from "./timeline"

type Images = Parameters<ReturnType<typeof api.agents.ref>["send"]>[1] extends infer O ? (O extends { images?: infer I } ? I : never) : never

/** New session from the draft (provider/model/effort; fork context or worktree if set). */
export async function createSession(text: string, images?: Images) {
  const { provider, thinking, fork, worktree } = draft()
  const models = draft().model ? [] : ((await api.providers.listModels(provider)).models ?? [])
  const model = draft().model ?? (models.find((m) => m.isDefault) ?? models[0])?.id
  if (!model) throw new Error(`No ${provider} models available on the daemon`)
  const cwd = fork?.cwd ?? process.cwd()
  const attachments = fork ? [fork.attachment] : undefined
  let id: string
  if (worktree) {
    const created = await daemon.createWorkspace({
      source: { kind: "worktree", cwd, action: "branch-off", ...(worktree.branch ? { branchName: worktree.branch } : {}) },
      agent: { config: { provider, model, cwd, ...(thinking ? { thinkingOptionId: thinking } : {}) }, initialPrompt: text, images, attachments },
    })
    if (!created.agent) throw new Error(created.error ?? "The worktree was created but its session wasn't")
    id = created.agent.id
  } else {
    const handle = await api.agents.create({
      config: { provider: `${provider}/${model}`, ...(thinking ? { thinkingOptionId: thinking } : {}) },
      cwd,
      prompt: text,
      images,
      attachments,
    })
    id = handle.id
  }
  setDraft({ ...draft(), fork: undefined, worktree: undefined })
  return id
}

/** OpenCode's `!` shell mode: run locally in the session's directory; the output rides along with the next message. */
export async function runShell(command: string, cwd: string) {
  const child = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  let output = (stdout + stderr).trimEnd()
  if (output.length > 8000) output = `${output.slice(0, 8000)}\n… (${output.length - 8000} more characters)`
  // Shown locally only; Paseo's timeline is the agent's, so this row disappears on reload.
  setTimeline(
    produce((draft) => {
      draft.rows.push({
        type: "tool_call",
        callId: `local-shell-${Date.now()}`,
        name: "shell (local)",
        status: exitCode === 0 ? "completed" : "failed",
        error: exitCode === 0 ? null : `exit ${exitCode}`,
        detail: { type: "shell", command, cwd, output, exitCode },
      } as AgentTimelineItem)
      draft.times.push(Date.now())
    }),
  )
  return `I ran \`${command}\` in ${cwd} (exit ${exitCode}):\n\`\`\`\n${output}\n\`\`\``
}

export async function copyText(text: string) {
  // OSC 52 works over SSH/tmux too; pbcopy covers terminals that ignore it.
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`)
  if (process.platform === "darwin") {
    const child = Bun.spawn(["pbcopy"], { stdin: "pipe" })
    child.stdin.write(text)
    child.stdin.end()
    await child.exited
  }
}

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
    while (timeline.hasOlder && (await loadOlder()));
    const target = path.resolve(agent.cwd, file)
    await writeFile(target, transcriptMarkdown(agent, timeline.rows))
    notify(`Exported to ${target}`, "success")
  } catch (error) {
    showError(error)
  }
}

/** OpenCode's session rename → Paseo's updateAgent({ name }) (the daemon's title, shown everywhere). */
export async function rename(id = current()?.id) {
  const agent = id ? agents[id] : undefined
  if (!agent) return
  const name = await dialogs.prompt({ title: "Rename session", value: agent.title ?? "" })
  if (!name?.trim()) return
  await daemon.updateAgent(agent.id, { name: name.trim() }).then(() => notify("Renamed", "success"), showError)
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

/** OpenCode's undo: rewind to before the last user message (and its file edits where the provider can), text back in the prompt. */
export async function undo(restore: (text: string) => void) {
  const agent = current()
  if (!agent) return
  const target = timeline.rows.findLast((row) => row.type === "user_message" && row.messageId)
  if (!target || target.type !== "user_message") return notify("Nothing to undo", "warning")
  const mode = agent.capabilities?.supportsRewindBoth ? "both" : agent.capabilities?.supportsRewindConversation ? "conversation" : undefined
  if (!mode) return notify(`${agent.provider} sessions can't rewind`, "warning")
  const result = await daemon.rewindAgent(agent.id, target.messageId!, mode).catch((error) => ({ ok: false, error: String(error) }))
  if (!result.ok) return showError(result.error ?? "Rewind failed")
  undone.set(agent.id, [...(undone.get(agent.id) ?? []), target.text])
  setUndoRevision((value) => value + 1)
  restore(target.text)
  notify(mode === "both" ? "Undid the last message and its file changes" : "Undid the last message (files unchanged)", "success")
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

/** Like the Paseo app's fork: carry a chat-history summary into a new session; the next prompt starts it. */
export async function fork() {
  const agent = current()
  if (!agent) return
  const context = await daemon.buildAgentForkContext(agent.id).catch((error) => ({ attachment: null, error: String(error) }))
  if (!context.attachment) return showError(context.error ?? "Fork failed")
  setDraft({
    provider: agent.provider,
    model: agent.model ?? undefined,
    label: agent.model ?? undefined,
    thinking: agent.thinkingOptionId ?? undefined,
    fork: { title: agent.title || "Untitled", cwd: agent.cwd, attachment: context.attachment },
  })
  navigate(undefined)
  notify(`Forking "${agent.title || "Untitled"}" — your next message starts the new session`)
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
export async function openChildren() {
  const agent = current()
  if (!agent) return
  const [children, native] = await Promise.all([
    daemon.fetchAgents({ filter: { labels: { "paseo.parent-agent-id": agent.id } } }).catch(() => ({ entries: [] })),
    daemon.listProviderSubagents(agent.id).catch(() => ({ subagents: [] })),
  ])
  const options = [
    ...children.entries.map(({ agent: child }) => ({
      title: child.title || "Untitled",
      value: `agent:${child.id}`,
      category: "Paseo agents",
      footer: child.status,
    })),
    ...native.subagents.map((child) => ({
      title: child.title || child.description || child.id,
      value: `native:${child.id}`,
      category: "Subagents (read-only)",
      footer: child.status,
    })),
  ]
  if (!options.length) return notify("No subagents in this session")
  const picked = await dialogs.select({ title: "Subagent sessions", options, size: "large" })
  if (!picked) return
  if (picked.startsWith("agent:")) return navigate(picked.slice(6))
  const id = picked.slice(7)
  const child = native.subagents.find((item) => item.id === id)!
  setSubagent({ parentId: agent.id, id, title: child.title || child.description || id })
  await openSubagentTimeline(agent.id, id).catch(showError)
}

export const hasParent = () => !!subagent() || !!current()?.labels?.["paseo.parent-agent-id"]

export function openParent() {
  const view = subagent()
  const parent = view?.parentId ?? current()?.labels?.["paseo.parent-agent-id"]
  if (parent) navigate(parent)
}

/** Next new session starts in a fresh git worktree branched from the current directory's repo. */
export async function newWorktreeDraft() {
  const branch = await dialogs.prompt({ title: "New session in a git worktree", description: "Branch name (empty = generated)", placeholder: "feature/…" })
  if (branch === undefined) return
  setDraft({ ...draft(), worktree: { branch: branch.trim() || undefined } })
  navigate(undefined)
  notify(`Next session starts in a new worktree of ${process.cwd()}`)
}
