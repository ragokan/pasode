import { decodePasteBytes, TextAttributes, type KeyEvent, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid"
import path from "node:path"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { runCommand } from "../commands"
import { truncate } from "../dialog"
import { offsetWidth, slashTrigger } from "./slash"
import { SplitBorder } from "../session"
import { theme } from "../theme"
import { readClipboard } from "./clipboard"
import { saveDraft, takeDraft } from "./drafts"
import { editPrompt } from "./editor"
import { promptHistory } from "./history"
import { mentionTrigger, quoteMention } from "./mention"
import { PromptMetadata, takeWidth } from "./metadata"
import { appendSnapshot, expandPasted, summarizePaste, type Pasted } from "./paste"
import { QueueDock } from "./queue"
import { PromptSpinner } from "./spinner"
import type { PromptProps, PromptRef, PromptSnapshot, PromptSubmit, SlashItem } from "./types"

export type { PromptProps, PromptRef, PromptSnapshot, PromptSubmit, SlashItem } from "./types"

/** A row of the completion popup: a "/" command or skill, or an "@" path. */
type Option = { label: string; description?: string; run: () => void }
/** Commands that act on the text around them, so they're offered mid-draft too (like skills): "/stash" shelves what you typed. */
const inlineCommands = new Set(["stash"])

// OpenCode v2.0.26 routes/home.tsx (MIT), selected once per prompt mount.
const examples = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"]
const EmptyBorder = { topLeft: " ", topRight: " ", bottomLeft: " ", bottomRight: " ", horizontal: " ", vertical: " ", topT: " ", bottomT: " ", leftT: " ", rightT: " ", cross: " " }

// Layout/metadata/attachment interactions ported from OpenCode v2.0.26
// packages/tui/src/component/prompt/index.tsx (MIT); Paseo owns submission.
export function Prompt(props: PromptProps) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const example = Math.floor(Math.random() * examples.length)
  let input: TextareaRenderable | undefined
  let disposed = false
  let submitting = false
  let editing = false
  let pasteQueue = Promise.resolve()
  let generation = 0
  // What the "[Pasted ~N lines]" tokens in the input stand for.
  let pasted: Pasted[] = []
  // The session whose draft is in the input (see the sessionId effect below).
  let owned: { id: string | undefined } | undefined
  // The message handed to the host and not yet confirmed.
  let sending: PromptSnapshot | undefined
  const [text, setTextSignal] = createSignal("")
  const [prefix, setPrefix] = createSignal("")
  const [images, setImages] = createSignal<PromptSubmit["images"]>([])
  // OpenCode v2.0.26 prompt image-preview sizing and three-thumbnail cap (MIT).
  const imagePreviewHeight = createMemo(() => Math.max(4, Math.min(8, Math.floor(dimensions().height / 4))))
  const imagePreviewWidth = () => imagePreviewHeight() * 2
  const visibleImages = createMemo(() => images().slice(0, 3))
  const placeholder = createMemo(() => {
    const value = `Ask anything… "${examples[example]}"`
    const width = dimensions().width < 44 ? dimensions().width - 5 : Math.min(75, dimensions().width - 4) - 5
    return takeWidth(value, Math.max(1, width)).trimEnd()
  })
  const [error, setError] = createSignal<string>()
  const [selected, setSelected] = createSignal(0)
  const [dismissed, setDismissed] = createSignal<string>()
  const report = (error: unknown) => { if (!disposed) setError(error instanceof Error ? error.message : String(error)) }

  const current = () => (input && !input.isDestroyed ? input.plainText : text())

  /** Tokens whose text was edited away are dropped. */
  function snapshot(): PromptSnapshot {
    const value = current()
    return { text: value, pasted: pasted.filter((part) => value.includes(part.token)), images: images() }
  }

  function restore(next: PromptSnapshot, cursor?: number) {
    generation++ // a paste still reading the clipboard belongs to the old prompt
    pasted = next.pasted
    setText(next.text)
    setImages(next.images)
    setError(undefined)
    if (cursor !== undefined && input) input.cursorOffset = Math.min(cursor, offsetWidth(next.text))
    sync()
  }

  function sync() {
    if (!input || disposed) return
    setTextSignal(input.plainText)
    setPrefix(input.getTextRange(0, input.cursorOffset))
  }

  function setText(value: string) {
    input?.setText(value)
    input?.gotoBufferEnd()
    setTextSignal(value)
    setPrefix(value)
  }

  function clear() {
    generation++
    pasted = []
    setText("")
    setImages([])
    setError(undefined)
  }

  const slash = createMemo(() => slashTrigger(prefix()))
  const mention = createMemo(() => (slash() ? undefined : mentionTrigger(prefix())))
  const completionKey = () => `${text()}:${prefix().length}`
  const slashOptions = createMemo<Option[]>(() => {
    if (!props.focused || dismissed() === completionKey()) return []
    const trigger = slash()
    if (!trigger) return []
    // Past the start of the prompt only skills (and inline commands) can be used; other commands there would be plain text.
    const items = trigger.index === 0 ? props.slashItems : props.slashItems.filter((item) => item.mention || inlineCommands.has(item.name))
    return items
      .filter((item) => item.name.toLowerCase().startsWith(trigger.query.toLowerCase()))
      .slice(0, 8)
      .map((item) => ({ label: trigger.index > 0 && item.mention ? item.mention : `/${item.name}`, description: item.description, run: () => pick(item) }))
  })
  // "@" paths from the daemon for the typed query, debounced like the Paseo app; the last answer stays up while the next loads.
  const [files, setFiles] = createSignal<{ path: string; kind: "file" | "directory" }[]>([])
  const mentionQuery = createMemo(() => (props.focused && props.suggestFiles ? mention()?.query : undefined))
  createEffect(on(() => props.cwd, () => setFiles([]), { defer: true })) // another workspace's paths aren't this one's
  createEffect(() => {
    const query = mentionQuery()
    void props.cwd
    if (query === undefined) return setFiles([])
    // Rerunning (another query or workspace) drops the pending request, so a late answer can't replace newer results.
    let stale = false
    const timer = setTimeout(() => {
      props.suggestFiles!(query).then((found) => !stale && setFiles(found), () => !stale && setFiles([]))
    }, 180)
    onCleanup(() => ((stale = true), clearTimeout(timer)))
  })
  const fileOptions = createMemo<Option[]>(() => {
    if (!props.focused || dismissed() === completionKey() || !mention()) return []
    return files().slice(0, 8).map((file) => {
      const dir = path.dirname(file.path)
      return { label: path.basename(file.path) + (file.kind === "directory" ? "/" : ""), description: dir === "." ? "" : dir, run: () => pickFile(file.path) }
    })
  })
  const options = () => (slashOptions().length ? slashOptions() : fileOptions())
  createEffect(on(() => `${completionKey()}:${props.cwd}`, () => setSelected(0)))
  createEffect(() => {
    if (selected() >= options().length) setSelected(0)
  })

  // Replaces only the "/query" token: a command at the start, a skill mention anywhere.
  function pick(item: SlashItem | undefined) {
    const trigger = slash()
    if (!item || !trigger || !props.focused || !input) return
    const insert = item.run ? "" : trigger.index > 0 && item.mention ? `${item.mention} ` : `/${item.name} `
    const before = prefix().slice(0, trigger.index) + insert
    input.setText(before + input.plainText.slice(prefix().length))
    input.cursorOffset = offsetWidth(before)
    sync()
    item.run?.()
  }

  // Replaces "@query" with the quoted path, like the Paseo app.
  function pickFile(file: string) {
    const trigger = mention()
    if (!trigger || !props.focused || !input) return
    const before = prefix().slice(0, trigger.index) + quoteMention(file)
    input.setText(before + input.plainText.slice(prefix().length))
    input.cursorOffset = offsetWidth(before)
    sync()
  }

  function paste(pastedText?: string) {
    const currentGeneration = generation
    pasteQueue = pasteQueue.then(async () => {
      const content = await readClipboard(pastedText, props.cwd)
      if (disposed || generation !== currentGeneration) return
      if ("image" in content) setImages((list) => [...list, { ...content.image }])
      else if ("text" in content) {
        const normalized = content.text.replace(/\r\n?/g, "\n")
        const part = summarizePaste(normalized, pasted)
        if (part) pasted.push(part)
        input?.insertText(part ? part.token + " " : normalized)
      }
      sync()
    }).catch(report)
  }

  // OpenCode's prompt.history.previous/next: ↑ at the very start (↓ at the very end) steps through submitted prompts;
  // elsewhere the arrows move the cursor, first to the edge. Returns false at the ends, so ↓ still opens the composer.
  function walkHistory(direction: 1 | -1) {
    if (!input) return false
    const edge = direction < 0 ? 0 : offsetWidth(input.plainText)
    if (input.cursorOffset !== edge) {
      const row = input.scrollY + input.visualCursor.visualRow
      if (row === (direction < 0 ? 0 : Math.max(0, input.editorView.getTotalVirtualLineCount() - 1))) input.cursorOffset = edge
      else if (direction < 0) input.moveCursorUp()
      else input.moveCursorDown()
      return true
    }
    const entry = promptHistory.move(direction, input.plainText)
    if (!entry) return false
    pasted = entry.pasted
    input.setText(entry.text)
    input.cursorOffset = direction < 0 ? 0 : offsetWidth(entry.text)
    sync()
    return true
  }

  function handleKey(key: KeyEvent): boolean {
    if (!props.focused || disposed || key.defaultPrevented || key.eventType === "release") return false
    const handled = (() => {
      if (key.ctrl && key.name === "v") return paste(), true
      if (!key.ctrl && !key.meta && !key.option) {
        const list = options()
        if (list.length) {
          if (!key.shift && key.name === "up") return setSelected((i) => (i - 1 + list.length) % list.length), true
          if (!key.shift && key.name === "down") return setSelected((i) => (i + 1) % list.length), true
          if (!key.shift && (key.name === "tab" || key.name === "return")) return list[selected()]?.run(), true
          if (key.name === "escape") return setDismissed(completionKey()), true
        }
        if (!key.shift && key.name === "backspace" && !(input?.plainText ?? text()).length && images().length)
          return setImages((list) => list.slice(0, -1)), true
        if (!key.shift && (key.name === "up" || key.name === "down")) return walkHistory(key.name === "up" ? -1 : 1)
      }
      return false
    })()
    if (handled) key.preventDefault()
    return handled
  }
  useKeyboard(handleKey)
  usePaste((event) => {
    if (!props.focused || event.defaultPrevented || disposed) return
    event.preventDefault()
    paste(decodePasteBytes(event.bytes))
  })

  async function submit(delivery?: "queue") {
    if (!props.focused || submitting || editing || disposed) return
    submitting = true
    const started = owned
    let sent: PromptSnapshot | undefined
    try {
      await pasteQueue
      // Another session's input is showing by now (leave() kept this one's draft): don't send it.
      if (disposed || owned !== started) return
      sent = sending = snapshot()
      const attached = sent.images
      const value: PromptSubmit = { text: expandPasted(sent.text, sent.pasted), images: attached }
      if (!value.text.trim() && !value.images.length) return
      setError(undefined)
      await props.onSubmit(value, { queue: delivery === "queue" })
      if (value.text.trim()) promptHistory.append({ text: sent.text, pasted: sent.pasted })
      // Do not discard edits or new images that arrived while the host was sending (or a draft of another session).
      if (!disposed && owned === started && current() === sent.text && images() === attached) clear()
    } catch (error) {
      // The input stopped showing this session meanwhile: the failed message goes back to its draft.
      if (sent && started && (disposed || owned !== started)) recover(started.id, sent)
      if (owned?.id === started?.id) report(error)
    } finally {
      submitting = false
      sending = undefined
    }
  }

  // Into the input when its session is showing again, else into that session's saved draft; after what was typed since.
  function recover(id: string | undefined, failed: PromptSnapshot) {
    if (!disposed && owned?.id === id) return restore(appendSnapshot(snapshot(), failed))
    const merged = appendSnapshot(takeDraft(id) ?? { text: "", pasted: [], images: [] }, failed)
    saveDraft(id, { ...merged, cursor: offsetWidth(merged.text) })
  }

  // One draft per session (the home screen is undefined): leaving one saves it, entering restores it. What is being
  // sent isn't a draft, so the home prompt that unmounts when its first message opens a session doesn't leave a copy;
  // edits made since the send began are.
  function leave() {
    if (!owned || renderer.isDestroyed) return
    const draft = snapshot()
    if (sending && draft.text === sending.text && draft.images === sending.images) return
    saveDraft(owned.id, { ...draft, cursor: offsetWidth(prefix()) })
  }
  createEffect(on(() => props.sessionId, (id) => {
    leave()
    owned = { id }
    const draft = takeDraft(id)
    restore(draft ?? { text: "", pasted: [], images: [] }, draft?.cursor)
  }))

  // OpenCode's prompt reclaims focus whenever nothing covers it (e.g. after a dialog or a remount).
  createEffect(() => {
    if (props.focused && input && !input.isDestroyed && !input.focused) input.focus()
  })

  const api: PromptRef = {
    text: () => input?.plainText ?? text(),
    setText: (value) => { generation++; pasted = []; setText(value) },
    clear,
    focus: () => { if (props.focused && !disposed) input?.focus() },
    isEmpty: () => !(input?.plainText ?? text()).length && !images().length,
    snapshot,
    restore,
    submit,
    handleKey,
    async openEditor() {
      if (editing || disposed) return
      editing = true
      try {
        await pasteQueue
        const snap = snapshot()
        const value = await editPrompt(expandPasted(snap.text, snap.pasted), props.cwd, renderer)
        if (!disposed) api.setText(value)
      } finally {
        editing = false
      }
    },
  }
  onMount(() => props.ref?.(api))
  onCleanup(() => { leave(); disposed = true; props.ref?.(undefined) })

  return (
    <box flexShrink={0} width="100%">
      <QueueDock sessionId={props.sessionId} onOpen={() => runCommand("prompt.queue.list")} />
      <Show when={options().length}>
        <box backgroundColor={theme.backgroundPanel} paddingTop={1} paddingBottom={1} flexShrink={0}>
          <For each={options()}>
            {(item, index) => {
              const active = () => index() === selected()
              return (
                <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2} backgroundColor={active() ? theme.primary : theme.backgroundPanel} onMouseUp={item.run}>
                  <text width={24} flexShrink={0} fg={active() ? theme.selectedListItemText : theme.text} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none" overflow="hidden">
                    {item.label}
                  </text>
                  <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none" overflow="hidden">{truncate(item.description ?? "", 70)}</text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      <box width="100%" border={["left"]} borderColor={props.agent.color} customBorderChars={{ ...SplitBorder, bottomLeft: "╹" }} flexShrink={0}>
        <box width="100%" flexGrow={1} flexShrink={0} paddingLeft={dimensions().width < 44 ? 1 : 2} paddingRight={dimensions().width < 44 ? 1 : 2} paddingTop={1} backgroundColor={theme.backgroundElement}>
          <Show when={visibleImages().length}>
            <box width="100%" height={imagePreviewHeight() + 1} flexDirection="row" flexShrink={0} justifyContent="flex-start" gap={1} paddingBottom={1}>
              <For each={visibleImages()}>
                {(image, index) => {
                  const [failed, setFailed] = createSignal(false)
                  return (
                    <box id={`prompt-image-${index()}`} width={imagePreviewWidth()} height={imagePreviewHeight()} flexBasis={imagePreviewWidth()} flexShrink={1}
                      onMouseUp={(event) => {
                        if (event.button !== 0 || !props.focused) return
                        event.stopPropagation()
                        setImages((list) => list.filter((item) => item !== image))
                      }}>
                      <Show when={!failed()} fallback={<box width="100%" height="100%" alignItems="center" justifyContent="center"><text fg={theme.textMuted}>No preview</text></box>}>
                        <image id={`prompt-image-preview-${index()}`} source={`data:${image.mimeType};base64,${image.data}`} fit="cover" protocol="auto" width="100%" height="100%" onError={() => setFailed(true)} />
                      </Show>
                    </box>
                  )
                }}
              </For>
              <Show when={images().length > visibleImages().length}>
                <box width={8} height={imagePreviewHeight()} flexBasis={8} flexShrink={1} alignItems="center" justifyContent="center">
                  <text fg={theme.textMuted} wrapMode="none" truncate>+{images().length - visibleImages().length} more</text>
                </box>
              </Show>
            </box>
            <text fg={theme.textMuted}>click image to remove · backspace when empty</text>
          </Show>
          <textarea
            width="100%"
            ref={(r: TextareaRenderable) => { input = r; sync() }}
            onContentChange={sync}
            onCursorChange={sync}
            focused={props.focused}
            placeholder={placeholder()}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            cursorColor={theme.text}
            minHeight={1}
            maxHeight={Math.max(6, Math.floor(dimensions().height / 3))}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", shift: true, action: "newline" },
              { name: "return", ctrl: true, action: "newline" },
              { name: "return", meta: true, action: "newline" },
              { name: "j", ctrl: true, action: "newline" },
            ]}
            onSubmit={() => void submit()}
          />
          <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
          <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
            <PromptMetadata agent={props.agent} model={props.model} />
          </box>
        </box>
      </box>
      <box height={1} border={["left"]} borderColor={props.agent.color} customBorderChars={{ ...EmptyBorder, vertical: theme.backgroundElement.a !== 0 ? "╹" : " " }}>
        <box height={1} border={["bottom"]} borderColor={theme.backgroundElement} customBorderChars={{ ...EmptyBorder, horizontal: theme.backgroundElement.a !== 0 ? "▀" : " " }} />
      </box>
      <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
        <box flexGrow={1} flexShrink={1} minWidth={0}>
          <Show when={props.status.running} fallback={<text fg={theme.textMuted} wrapMode="none" truncate flexGrow={1} flexShrink={1}>{props.location}</text>}>
            <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-start">
              <box marginLeft={1}><PromptSpinner color={props.agent.color} /></box>
              <text fg={props.status.interruptArmed ? theme.warning : theme.text} wrapMode="none" truncate flexShrink={1}>
                esc <span style={{ fg: props.status.interruptArmed ? theme.warning : theme.textMuted }}>{props.status.interruptArmed ? "again to interrupt" : "interrupt"}</span>
              </text>
            </box>
          </Show>
        </box>
        {props.footerRight}
      </box>
    </box>
  )
}
