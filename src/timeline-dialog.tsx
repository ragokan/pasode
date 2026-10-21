// Jump-to-message and its actions, after OpenCode's routes/session/dialog-timeline.tsx + dialog-message.tsx (MIT).
// Lists every user message of the session (the daemon's prompt index), not only the loaded ones, and searches them all.
import { createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import * as actions from "./actions"
import { dialog, DialogSelect, type SelectOption } from "./dialog"
import { matchedPrompts, promptKeys, promptPreview, userRowKeys, type Prompt } from "./messages"
import { daemon, loadOlder, timeline } from "./paseo"
import { Spinner } from "./session"
import { current, notify, showError, subagent } from "./state"

type Handlers = { scrollToRow: (index: number) => void; restore: (text: string) => void }

const stamp = (iso: string) => {
  const at = new Date(iso)
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`
}

/** Pages history in until the user message with this key is loaded. */
async function loadUntil(agentId: string | undefined, key: string, time: number) {
  const find = () => userRowKeys(timeline.rows, timeline.times).get(key)
  // Rows can share the oldest loaded timestamp, hence <=.
  while (find() === undefined && timeline.agentId === agentId && timeline.hasOlder && time <= (timeline.times[0] ?? Infinity) && (await loadOlder()));
  return timeline.agentId === agentId ? find() : undefined
}

export function TimelineDialog(props: Handlers) {
  const id = timeline.agentId
  // A provider-native subagent isn't a daemon agent, so its loaded rows are all there is (and nothing can be searched).
  let searchable = !!id && !subagent()
  const loaded = () =>
    timeline.rows.flatMap((row, index): Prompt[] =>
      row.type === "user_message" ? [{ seq: -1, timestamp: new Date(timeline.times[index]!).toISOString(), preview: promptPreview(row.text) }] : [],
    )
  const [prompts] = createResource(async () => {
    if (searchable) {
      try {
        return (await daemon.listAgentTimelinePrompts(id!)).prompts
      } catch (error) {
        showError(error)
        searchable = false
      }
    }
    return loaded()
  })
  const [query, setQuery] = createSignal("")
  const [hits, setHits] = createSignal<Map<number, "user" | "assistant">>()
  let token = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => (token++, clearTimeout(timer)))

  const options = createMemo(() => {
    const found = query().trim() ? (hits() ?? new Map()) : undefined
    return (prompts.latest ?? [])
      .filter((prompt) => !found || found.has(prompt.seq))
      .toReversed()
      .map((prompt): SelectOption<Prompt> => ({
        title: prompt.preview.startsWith("<chat-history-summary>") ? "↳ forked from another session" : prompt.preview,
        value: prompt,
        description: found?.get(prompt.seq) === "assistant" ? "in reply" : undefined,
        footer: stamp(prompt.timestamp),
      }))
  })

  const keys = createMemo(() => promptKeys(prompts.latest ?? []))
  const loadedAt = (prompt: Prompt) => userRowKeys(timeline.rows, timeline.times).get(keys().get(prompt)!)
  /** Scrolls to the message behind the selection when its page is loaded. */
  const preview = (prompt?: Prompt) => {
    const index = prompt && loadedAt(prompt)
    if (index !== undefined) props.scrollToRow(index)
  }
  let started = false

  function search(value: string) {
    setQuery(value)
    setHits(undefined)
    clearTimeout(timer)
    const mine = ++token
    if (!value.trim()) return
    // shortcut: the first 200 matches only (the daemon's page), no further paging.
    timer = setTimeout(
      () =>
        daemon.searchAgentTimeline({ agentId: id!, query: value }).then(
          (result) => mine === token && (setHits(matchedPrompts(prompts.latest ?? [], result.locations)), preview(options()[0]?.value)),
          (error) => mine === token && (showError(error), setHits(new Map())),
        ),
      200,
    )
  }

  async function pick(prompt: Prompt) {
    let index = loadedAt(prompt)
    if (index === undefined) {
      dialog.clear()
      notify("Loading older messages…")
      index = await loadUntil(id, keys().get(prompt)!, Date.parse(prompt.timestamp))
      if (index === undefined) return notify("Couldn't load that message", "warning")
      if (dialog.isOpen) return
    }
    const row = timeline.rows[index]
    // Snapshot now: a refetch rewrites loaded rows in place while the dialogs are open.
    const chosen = row?.type === "user_message" ? actions.chooseMessage(row) : undefined
    if (chosen) dialog.replace(() => <MessageActions chosen={chosen} {...props} />, "large")
  }

  return (
    <Show
      when={prompts.latest}
      fallback={
        <box paddingLeft={4} paddingBottom={1}>
          <Spinner>Loading messages…</Spinner>
        </box>
      }
    >
      <DialogSelect
        title="Jump to message"
        emptyText={query().trim() ? (hits() ? "No messages match" : "Searching…") : "No messages yet"}
        options={options()}
        onFilter={searchable ? search : undefined}
        onMove={(option) => (started ? preview(option.value) : (started = true))}
        onSelect={(option) => void pick(option.value)}
      />
    </Show>
  )
}

function MessageActions(props: Handlers & { chosen: actions.Chosen }) {
  const readOnly = () => (subagent() ? "read-only subagent view" : undefined)
  const agent = current()
  const choices = [
    {
      title: "Jump to message",
      description: "view message in session",
      run: () => {
        dialog.clear()
        const index = actions.locateMessage(props.chosen)
        if (index < 0) actions.gone()
        else props.scrollToRow(index)
      },
    },
    {
      title: "Revert to here",
      description: "undo this message and everything after",
      blocked: readOnly() ?? (agent ? actions.revertBlocker(agent, props.chosen) : "no session"),
      run: () => (dialog.clear(), void actions.revertTo(props.chosen, props.restore)),
    },
    {
      title: "Copy",
      description: "message text to clipboard",
      run: () => (dialog.clear(), void actions.copyText(props.chosen.text).then(() => notify("Copied message", "success"), showError)),
    },
    {
      title: "Fork from here",
      description: "new session with the history before this message",
      blocked: readOnly(),
      run: () => (dialog.clear(), void actions.fork({ chosen: props.chosen, restore: props.restore })),
    },
  ]
  return (
    <DialogSelect
      title="Message actions"
      search={false}
      options={choices.map((choice) => ({ title: choice.title, description: choice.blocked ? `unavailable: ${choice.blocked}` : choice.description, value: choice }))}
      onSelect={(option) => (option.value.blocked ? notify(option.value.blocked, "warning") : option.value.run())}
    />
  )
}
