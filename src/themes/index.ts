// Built-in assets and legacy resolution adapted from OpenCode (MIT), packages/tui/src/theme.
import { RGBA } from "@opentui/core"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ThemeColors } from "../theme"

type Mode = "dark" | "light"
type ThemeSource = "builtin" | "opencode" | "pascode"
type ThemeEntry = { name: string; source: ThemeSource; path: string }

async function discoverThemes(): Promise<ThemeEntry[]> {
  const themes = new Map<string, ThemeEntry>()
  const directories: [ThemeSource, string][] = [
    ["builtin", join(import.meta.dir, "assets")],
    ["opencode", join(homedir(), ".config/opencode/themes")],
    ["pascode", join(homedir(), ".config/pascode/themes")],
  ]
  for (const [source, directory] of directories) {
    const files = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && source !== "builtin") return []
      throw error
    })
    for (const file of files) {
      if (!file.name.endsWith(".json") || (!file.isFile() && !file.isSymbolicLink())) continue
      const name = file.name.slice(0, -5)
      themes.set(name, { name, source, path: join(directory, file.name) })
    }
  }
  return [...themes.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function listThemes(): Promise<{ name: string; source: ThemeSource }[]> {
  return (await discoverThemes()).map(({ name, source }) => ({ name, source }))
}

export async function loadTheme(name: string, mode: Mode): Promise<ThemeColors> {
  const entry = (await discoverThemes()).find((entry) => entry.name === name)
  if (!entry) throw new Error(`Unknown theme: ${name}`)
  return resolveThemeJson(await Bun.file(entry.path).json(), mode)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function merge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => {
    const left = base[key]
    const right = override[key]
    return [key, isRecord(left) && isRecord(right) ? merge(left, right) : right ?? left]
  }))
}

const tokenPaths = {
  primary: "hue.interactive.200",
  secondary: "hue.purple.200",
  accent: "hue.accent.200",
  error: "text.feedback.error.base",
  warning: "text.feedback.warning.base",
  success: "text.feedback.success.base",
  info: "text.feedback.info.base",
  text: "text.base",
  textMuted: "text.muted",
  selectedListItemText: "text.action.primary.$focused",
  background: "background.base",
  backgroundPanel: "background.raised.base",
  backgroundElement: "background.raised.high",
  // shortcut: flat ThemeColors keeps only the dialog background, expand when contextual state colors are exposed.
  backgroundMenu: "@dialog.background.base",
  border: "border.base",
  borderActive: "scrollbar.base",
  borderSubtle: "background.raised.base",
  diffAdded: "diff.text.added",
  diffRemoved: "diff.text.removed",
  diffContext: "diff.text.context",
  diffHunkHeader: "diff.text.hunkHeader",
  diffHighlightAdded: "diff.highlight.added",
  diffHighlightRemoved: "diff.highlight.removed",
  diffAddedBg: "diff.background.added",
  diffRemovedBg: "diff.background.removed",
  diffContextBg: "diff.background.context",
  diffLineNumber: "diff.lineNumber.text",
  diffAddedLineNumberBg: "diff.lineNumber.background.added",
  diffRemovedLineNumberBg: "diff.lineNumber.background.removed",
  markdownText: "markdown.text",
  markdownHeading: "markdown.heading",
  markdownLink: "markdown.link",
  markdownLinkText: "markdown.linkText",
  markdownCode: "markdown.code",
  markdownBlockQuote: "markdown.blockQuote",
  markdownEmph: "markdown.emphasis",
  markdownStrong: "markdown.strong",
  markdownHorizontalRule: "markdown.horizontalRule",
  markdownListItem: "markdown.listItem",
  markdownListEnumeration: "markdown.listEnumeration",
  markdownImage: "markdown.image",
  markdownImageText: "markdown.imageText",
  markdownCodeBlock: "markdown.codeBlock",
  syntaxComment: "syntax.comment",
  syntaxKeyword: "syntax.keyword",
  syntaxFunction: "syntax.function",
  syntaxVariable: "syntax.variable",
  syntaxString: "syntax.string",
  syntaxNumber: "syntax.number",
  syntaxType: "syntax.type",
  syntaxOperator: "syntax.operator",
  syntaxPunctuation: "syntax.punctuation",
} satisfies Record<keyof ThemeColors, string>

export function resolveThemeJson(json: unknown, mode: Mode): ThemeColors {
  if (!isRecord(json)) throw new Error("Theme must be a JSON object")
  const legacy = isRecord(json.theme)
  if (!legacy && !isRecord(json.base)) throw new Error("Theme requires a theme or base object")
  const activeMode = !legacy && json[mode] === undefined ? (mode === "dark" ? "light" : "dark") : mode
  const variant = json[activeMode]
  if (!legacy && !isRecord(variant)) throw new Error("Theme requires a dark or light mode object")
  const tokens = legacy ? json.theme as Record<string, unknown> : merge(json.base as Record<string, unknown>, variant as Record<string, unknown>)
  const defs = isRecord(json.defs) ? json.defs : {}

  function reference(path: string, chain: string[] = []): unknown {
    if (chain.includes(path)) throw new Error(`Circular color reference: ${[...chain, path].join(" -> ")}`)
    let value: unknown = tokens
    for (const segment of path.split(".")) {
      while (typeof value === "string" && value.startsWith("$")) {
        value = reference(value.slice(1), [...chain, path])
      }
      value = isRecord(value) && Object.hasOwn(value, segment) ? value[segment] : undefined
    }
    if (typeof value === "string" && value.startsWith("$")) return reference(value.slice(1), [...chain, path])
    if (value === undefined && chain.length) throw new Error(`Color reference not found: $${path}`)
    return value
  }

  function color(value: unknown, chain: string[] = []): RGBA {
    if (value instanceof RGBA) return value
    if (typeof value === "number") return RGBA.fromIndex(value)
    if (isRecord(value)) return color(value[activeMode] ?? value[activeMode === "dark" ? "light" : "dark"], chain)
    if (typeof value !== "string") throw new Error("Invalid theme color")
    if (value === "none" || value === "transparent") return RGBA.fromInts(0, 0, 0, 0)
    if (value.startsWith("#")) {
      if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) throw new Error(`Invalid hex color: ${value}`)
      return RGBA.fromHex(value)
    }
    if (chain.includes(value)) throw new Error(`Circular color reference: ${[...chain, value].join(" -> ")}`)
    const next = legacy
      ? (Object.hasOwn(defs, value) ? defs[value] : Object.hasOwn(tokens, value) ? tokens[value] : undefined)
      : reference(value.startsWith("$") ? value.slice(1) : value)
    if (next === undefined) throw new Error(`Color reference not found: ${value}`)
    return color(next, [...chain, value])
  }

  const resolved: Partial<ThemeColors> = {}
  for (const key of Object.keys(tokenPaths) as (keyof ThemeColors)[]) {
    const value = legacy ? tokens[key] : reference(tokenPaths[key])
    if (value !== undefined) resolved[key] = color(value)
  }
  return withFallbacks(resolved, activeMode)
}

function withFallbacks(colors: Partial<ThemeColors>, mode: Mode): ThemeColors {
  const background = colors.background ?? RGBA.fromHex(mode === "dark" ? "#181818" : "#ffffff")
  const text = colors.text ?? RGBA.fromHex(mode === "dark" ? "#eeeeee" : "#202020")
  const primary = colors.primary ?? RGBA.fromHex(mode === "dark" ? "#82aaff" : "#3b7dd8")
  const secondary = colors.secondary ?? primary
  const accent = colors.accent ?? secondary
  const error = colors.error ?? RGBA.fromHex(mode === "dark" ? "#e06c75" : "#d1383d")
  const warning = colors.warning ?? RGBA.fromHex(mode === "dark" ? "#e5c07b" : "#b0851f")
  const success = colors.success ?? RGBA.fromHex(mode === "dark" ? "#7fd88f" : "#3d9a57")
  const info = colors.info ?? primary
  const mix = (base: RGBA, overlay: RGBA, amount: number) => RGBA.fromValues(
    base.r + (overlay.r - base.r) * amount,
    base.g + (overlay.g - base.g) * amount,
    base.b + (overlay.b - base.b) * amount,
  )
  const textMuted = colors.textMuted ?? mix(background, text, 0.6)
  const backgroundPanel = colors.backgroundPanel ?? mix(background, text, 0.04)
  const backgroundElement = colors.backgroundElement ?? mix(background, text, 0.08)
  const border = colors.border ?? mix(background, text, 0.2)
  const diffAddedBg = colors.diffAddedBg ?? mix(background, success, 0.15)
  const diffRemovedBg = colors.diffRemovedBg ?? mix(background, error, 0.15)
  return {
    primary, secondary, accent, error, warning, success, info, text, textMuted,
    selectedListItemText: background,
    background, backgroundPanel, backgroundElement, backgroundMenu: backgroundElement,
    border, borderActive: primary, borderSubtle: backgroundPanel,
    diffAdded: success, diffRemoved: error, diffContext: textMuted, diffHunkHeader: info,
    diffHighlightAdded: success, diffHighlightRemoved: error,
    diffAddedBg, diffRemovedBg, diffContextBg: backgroundPanel, diffLineNumber: textMuted,
    diffAddedLineNumberBg: diffAddedBg, diffRemovedLineNumberBg: diffRemovedBg,
    markdownText: text, markdownHeading: accent, markdownLink: primary, markdownLinkText: info,
    markdownCode: success, markdownBlockQuote: textMuted, markdownEmph: warning, markdownStrong: text,
    markdownHorizontalRule: border, markdownListItem: primary, markdownListEnumeration: info,
    markdownImage: primary, markdownImageText: info, markdownCodeBlock: text,
    syntaxComment: textMuted, syntaxKeyword: accent, syntaxFunction: primary, syntaxVariable: text,
    syntaxString: success, syntaxNumber: warning, syntaxType: secondary, syntaxOperator: accent,
    syntaxPunctuation: textMuted,
    ...colors,
  }
}
