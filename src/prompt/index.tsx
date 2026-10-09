import { decodePasteBytes, TextAttributes, type KeyEvent, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, usePaste, useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { truncate } from "../dialog"
import { SplitBorder } from "../session"
import { theme } from "../theme"
import { listFiles, mentionQuery, promptOffsetWidth, rankFiles } from "./autocomplete"
import { readClipboard } from "./clipboard"
import { editPrompt } from "./editor"
import { PromptHistory, readHistory, writeHistory } from "./history"
import { shellTransition } from "./mode"
import type { PromptProps, PromptRef, PromptSubmit, SlashItem } from "./types"

export type { PromptProps, PromptRef, PromptSubmit, SlashItem } from "./types"

let savedHistory: PromptHistory | undefined

// OpenCode's prompt layout and interaction patterns (MIT), pared down for Paseo.
export function Prompt(props: PromptProps) {
  const renderer = useRenderer()
  let input: TextareaRenderable | undefined
  let disposed = false
  let submitting = false
  let editing = false
  let pasteQueue = Promise.resolve()
  let generation = 0
  let draftImages: PromptSubmit["images"] = []
  const [text, setTextSignal] = createSignal("")
  const [prefix, setPrefix] = createSignal("")
  const [mode, setMode] = createSignal<PromptSubmit["mode"]>("normal")
  const [images, setImages] = createSignal<PromptSubmit["images"]>([])
  const [error, setError] = createSignal<string>()
  const [selected, setSelected] = createSignal(0)
  const [dismissed, setDismissed] = createSignal<string>()
  const report = (error: unknown) => { if (!disposed) setError(error instanceof Error ? error.message : String(error)) }
  let history = new PromptHistory()
  let historyWritable = true
  try {
    history = savedHistory ??= new PromptHistory(readHistory())
    history.reset()
  } catch (error) {
    historyWritable = false
    report(error)
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
    setText("")
    setMode("normal")
    setImages([])
    draftImages = []
    history.reset()
    setError(undefined)
  }

  const mention = createMemo(() => mentionQuery(text(), prefix().length))
  const slashQuery = createMemo(() => prefix() === text() ? text().match(/^\/(\S*)$/)?.[1]?.toLowerCase() : undefined)
  const completionKey = () => `${mode()}:${text()}:${prefix().length}`
  const [files] = createResource(
    () => mode() === "normal" && !!mention() && props.focused ? props.cwd : undefined,
    (cwd) => listFiles(cwd).catch((error) => { report(error); return [] }),
  )
  const options = createMemo<SlashItem[]>(() => {
    if (!props.focused || mode() === "shell" || dismissed() === completionKey()) return []
    const query = slashQuery()
    if (query !== undefined) return props.slashItems.filter((item) => item.name.toLowerCase().startsWith(query)).slice(0, 8)
    if (files.loading) return []
    const token = mention()
    return token ? rankFiles(files() ?? [], token.query).map((name) => ({ name })) : []
  })
  createEffect(on(() => `${completionKey()}:${props.cwd}`, () => setSelected(0)))
  createEffect(() => {
    if (selected() >= options().length) setSelected(0)
  })

  function pick(item: SlashItem | undefined) {
    if (!item || !props.focused) return
    if (slashQuery() !== undefined) {
      setText(item.run ? "" : `/${item.name} `)
      item.run?.()
      return
    }
    const token = mention()
    if (!token) return
    const before = `${text().slice(0, token.start)}@${item.name} `
    setText(before + text().slice(token.end))
    if (input) input.cursorOffset = promptOffsetWidth(before)
    sync()
    input?.focus()
  }

  function paste(pastedText?: string) {
    const currentGeneration = generation
    pasteQueue = pasteQueue.then(async () => {
      const content = await readClipboard(pastedText)
      if (disposed || generation !== currentGeneration) return
      if ("image" in content) setImages((list) => [...list, content.image])
      else input?.insertText(content.text.replace(/\r\n?/g, "\n"))
      sync()
    }).catch(report)
  }

  function handleKey(key: KeyEvent): boolean {
    if (!props.focused || disposed || key.defaultPrevented || key.eventType === "release") return false
    const handled = (() => {
      if (key.ctrl && key.name === "v") return paste(), true
      if (!key.ctrl && !key.meta) {
        const list = options()
        if (list.length) {
          if (!key.shift && key.name === "up") return setSelected((i) => (i - 1 + list.length) % list.length), true
          if (!key.shift && key.name === "down") return setSelected((i) => (i + 1) % list.length), true
          if (!key.shift && (key.name === "tab" || key.name === "return")) return pick(list[selected()]), true
          if (key.name === "escape") return setDismissed(completionKey()), true
        }
        const nextMode = shellTransition(mode(), input?.plainText ?? text(), key.sequence === "!" ? "!" : key.name)
        if (nextMode) return setMode(nextMode), true
        if (key.shift) return false
        if (input && (key.name === "up" || key.name === "down")) {
          const row = input.scrollY + input.visualCursor.visualRow
          if (key.name === "up" && row !== 0) return false
          if (key.name === "down" && row !== Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)) return false
          const wasBrowsing = history.browsing
          const entry = history.move(key.name === "up" ? -1 : 1, { text: input.plainText, mode: mode() })
          if (!entry) return false
          if (!wasBrowsing) draftImages = images()
          setImages(history.browsing ? [] : draftImages)
          setMode(entry.mode)
          setText(entry.text)
          // Keep ↑ at the top and ↓ at the bottom of multiline history entries.
          if (key.name === "up") input.gotoBufferHome()
          sync()
          return true
        }
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

  async function submit() {
    if (!props.focused || submitting || editing || disposed) return
    submitting = true
    try {
      await pasteQueue
      if (disposed) return
      const original = input?.plainText ?? text()
      const attached = images()
      const currentMode = mode()
      const value: PromptSubmit = { text: original.trim(), mode: currentMode, images: attached }
      if (!value.text && !value.images.length) return
      setError(undefined)
      await props.onSubmit(value)
      history.append({ text: value.text, mode: value.mode })
      // Do not discard edits or new images that arrived while the host was sending.
      if (!disposed && (input?.plainText ?? text()) === original && images() === attached && mode() === currentMode) clear()
      if (historyWritable) await writeHistory(history.entries).catch(report)
    } catch (error) {
      report(error)
    } finally {
      submitting = false
    }
  }

  const api: PromptRef = {
    text: () => input?.plainText ?? text(),
    setText: (value) => { generation++; history.reset(); setText(value) },
    clear,
    focus: () => { if (props.focused && !disposed) input?.focus() },
    isEmpty: () => !(input?.plainText ?? text()).length && !images().length,
    handleKey,
    async openEditor() {
      if (editing || disposed) return
      editing = true
      try {
        await pasteQueue
        const value = await editPrompt(api.text(), props.cwd, renderer)
        if (!disposed) api.setText(value)
      } finally {
        editing = false
      }
    },
  }
  onMount(() => props.ref?.(api))
  onCleanup(() => { disposed = true; props.ref?.(undefined) })
  const color = () => mode() === "shell" ? theme.warning : theme.primary

  return (
    <box flexShrink={0}>
      <Show when={options().length}>
        <box backgroundColor={theme.backgroundPanel} paddingTop={1} paddingBottom={1} flexShrink={0}>
          <For each={options()}>
            {(item, index) => {
              const active = () => index() === selected()
              return (
                <box flexDirection="row" paddingLeft={2} paddingRight={2} backgroundColor={active() ? theme.primary : theme.backgroundPanel} onMouseUp={() => pick(item)}>
                  <text width={slashQuery() !== undefined ? 24 : undefined} flexGrow={slashQuery() === undefined ? 1 : 0} flexShrink={0} fg={active() ? theme.selectedListItemText : theme.text} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none" overflow="hidden">
                    {slashQuery() !== undefined ? "/" : "@"}{item.name}
                  </text>
                  <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none" overflow="hidden">{truncate(item.description ?? "", 70)}</text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      <box border={["left"]} borderColor={color()} customBorderChars={SplitBorder} flexShrink={0}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1} backgroundColor={theme.backgroundElement} gap={1}>
          <Show when={images().length}>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              <For each={images()}>{(_, index) => <text fg={theme.accent}>[Image {index() + 1}]</text>}</For>
            </box>
          </Show>
          <textarea
            ref={(r: TextareaRenderable) => { input = r; sync() }}
            onContentChange={sync}
            onCursorChange={sync}
            focused={props.focused}
            placeholder={mode() === "shell" ? "Run a shell command…" : props.placeholder}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            backgroundColor={theme.backgroundElement}
            focusedBackgroundColor={theme.backgroundElement}
            cursorColor={theme.text}
            minHeight={1}
            maxHeight={8}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", shift: true, action: "newline" },
              { name: "return", ctrl: true, action: "newline" },
              { name: "j", ctrl: true, action: "newline" },
            ]}
            onSubmit={() => void submit()}
          />
          <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
          <box flexDirection="row" gap={1} paddingBottom={1}>
            <Show when={mode() === "shell"}><text fg={color()} attributes={TextAttributes.BOLD}>Shell</text></Show>
            {props.footer}
          </box>
        </box>
      </box>
    </box>
  )
}
