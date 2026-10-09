import { decodePasteBytes, TextAttributes, type KeyEvent, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { truncate } from "../dialog"
import { SplitBorder } from "../session"
import { theme } from "../theme"
import { readClipboard } from "./clipboard"
import { editPrompt } from "./editor"
import { PromptMetadata, takeWidth } from "./metadata"
import { PromptSpinner } from "./spinner"
import type { PromptProps, PromptRef, PromptSubmit, SlashItem } from "./types"

export type { PromptProps, PromptRef, PromptSubmit, SlashItem } from "./types"

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
    setImages([])
    setError(undefined)
  }

  const slashQuery = createMemo(() => prefix() === text() ? text().match(/^\/(\S*)$/)?.[1]?.toLowerCase() : undefined)
  const completionKey = () => `${text()}:${prefix().length}`
  const options = createMemo<SlashItem[]>(() => {
    if (!props.focused || dismissed() === completionKey()) return []
    const query = slashQuery()
    return query === undefined ? [] : props.slashItems.filter((item) => item.name.toLowerCase().startsWith(query)).slice(0, 8)
  })
  createEffect(on(() => `${completionKey()}:${props.cwd}`, () => setSelected(0)))
  createEffect(() => {
    if (selected() >= options().length) setSelected(0)
  })

  function pick(item: SlashItem | undefined) {
    if (!item || !props.focused) return
    setText(item.run ? "" : `/${item.name} `)
    item.run?.()
  }

  function paste(pastedText?: string) {
    const currentGeneration = generation
    pasteQueue = pasteQueue.then(async () => {
      const content = await readClipboard(pastedText, props.cwd)
      if (disposed || generation !== currentGeneration) return
      if ("image" in content) setImages((list) => [...list, { ...content.image }])
      else if ("text" in content) input?.insertText(content.text.replace(/\r\n?/g, "\n"))
      sync()
    }).catch(report)
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
          if (!key.shift && (key.name === "tab" || key.name === "return")) return pick(list[selected()]), true
          if (key.name === "escape") return setDismissed(completionKey()), true
        }
        if (!key.shift && key.name === "backspace" && !(input?.plainText ?? text()).length && images().length)
          return setImages((list) => list.slice(0, -1)), true
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
      const value: PromptSubmit = { text: original, images: attached }
      if (!value.text.trim() && !value.images.length) return
      setError(undefined)
      await props.onSubmit(value)
      // Do not discard edits or new images that arrived while the host was sending.
      if (!disposed && (input?.plainText ?? text()) === original && images() === attached) clear()
    } catch (error) {
      report(error)
    } finally {
      submitting = false
    }
  }

  const api: PromptRef = {
    text: () => input?.plainText ?? text(),
    setText: (value) => { generation++; setText(value) },
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

  return (
    <box flexShrink={0} width="100%">
      <Show when={options().length}>
        <box backgroundColor={theme.backgroundPanel} paddingTop={1} paddingBottom={1} flexShrink={0}>
          <For each={options()}>
            {(item, index) => {
              const active = () => index() === selected()
              return (
                <box flexDirection="row" paddingLeft={2} paddingRight={2} backgroundColor={active() ? theme.primary : theme.backgroundPanel} onMouseUp={() => pick(item)}>
                  <text width={24} flexShrink={0} fg={active() ? theme.selectedListItemText : theme.text} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none" overflow="hidden">
                    /{item.name}
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
