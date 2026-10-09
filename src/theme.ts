import { RGBA, SyntaxStyle } from "@opentui/core"
import { createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

/** Same color keys as OpenCode's TUI Theme (packages/tui/src/theme/index.ts), so its themes port 1:1. */
export type ThemeColors = {
  primary: RGBA
  secondary: RGBA
  accent: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  selectedListItemText: RGBA
  background: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  backgroundMenu: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  diffContext: RGBA
  diffHunkHeader: RGBA
  diffHighlightAdded: RGBA
  diffHighlightRemoved: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  diffContextBg: RGBA
  diffLineNumber: RGBA
  diffAddedLineNumberBg: RGBA
  diffRemovedLineNumberBg: RGBA
  markdownText: RGBA
  markdownHeading: RGBA
  markdownLink: RGBA
  markdownLinkText: RGBA
  markdownCode: RGBA
  markdownBlockQuote: RGBA
  markdownEmph: RGBA
  markdownStrong: RGBA
  markdownHorizontalRule: RGBA
  markdownListItem: RGBA
  markdownListEnumeration: RGBA
  markdownImage: RGBA
  markdownImageText: RGBA
  markdownCodeBlock: RGBA
  syntaxComment: RGBA
  syntaxKeyword: RGBA
  syntaxFunction: RGBA
  syntaxVariable: RGBA
  syntaxString: RGBA
  syntaxNumber: RGBA
  syntaxType: RGBA
  syntaxOperator: RGBA
  syntaxPunctuation: RGBA
}

const hex = RGBA.fromHex

/** Built-in fallback: your OpenCode theme, monokai-pro-ristretto (dark). */
export const ristretto: ThemeColors = {
  primary: hex("#a4cff9"),
  secondary: hex("#c8caf4"),
  accent: hex("#ffa5b1"),
  error: hex("#ffa5b1"),
  warning: hex("#ffd6a5"),
  success: hex("#cce9ae"),
  info: hex("#b6e8df"),
  text: hex("#f1e3e5"),
  textMuted: hex("#958a8b"),
  selectedListItemText: hex("#2c2525"),
  background: hex("#2c2525"),
  backgroundPanel: hex("#362e2e"),
  backgroundElement: hex("#3f3737"),
  backgroundMenu: hex("#362e2e"),
  border: hex("#3f3737"),
  borderActive: hex("#685f5f"),
  borderSubtle: hex("#362e2e"),
  diffAdded: hex("#cce9ae"),
  diffRemoved: hex("#ffa5b1"),
  diffContext: hex("#958a8b"),
  diffHunkHeader: hex("#b6e8df"),
  diffHighlightAdded: hex("#dff2cd"),
  diffHighlightRemoved: hex("#ffc9ce"),
  diffAddedBg: hex("#3a3f31"),
  diffRemovedBg: hex("#4a3034"),
  diffContextBg: hex("#362e2e"),
  diffLineNumber: hex("#685f5f"),
  diffAddedLineNumberBg: hex("#494c39"),
  diffRemovedLineNumberBg: hex("#5a363a"),
  markdownText: hex("#f1e3e5"),
  markdownHeading: hex("#ffa5b1"),
  markdownLink: hex("#a4cff9"),
  markdownLinkText: hex("#b6e8df"),
  markdownCode: hex("#cce9ae"),
  markdownBlockQuote: hex("#c2b5b7"),
  markdownEmph: hex("#ffd6a5"),
  markdownStrong: hex("#fce0a8"),
  markdownHorizontalRule: hex("#3f3737"),
  markdownListItem: hex("#a4cff9"),
  markdownListEnumeration: hex("#b6e8df"),
  markdownImage: hex("#a4cff9"),
  markdownImageText: hex("#b6e8df"),
  markdownCodeBlock: hex("#f1e3e5"),
  syntaxComment: hex("#958a8b"),
  syntaxKeyword: hex("#ffa5b1"),
  syntaxFunction: hex("#a4cff9"),
  syntaxVariable: hex("#f1e3e5"),
  syntaxString: hex("#cce9ae"),
  syntaxNumber: hex("#ffd6a5"),
  syntaxType: hex("#c8caf4"),
  syntaxOperator: hex("#ffa5b1"),
  syntaxPunctuation: hex("#c2b5b7"),
}

/** Reactive: read `theme.x` inside JSX/effects and it follows `applyTheme`. */
export const [theme, setThemeStore] = createStore<ThemeColors>({ ...ristretto })

function buildSyntax(colors: ThemeColors) {
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: colors.markdownText } },
    { scope: ["markup.heading"], style: { foreground: colors.markdownHeading, bold: true } },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: colors.markdownStrong, bold: true } },
    { scope: ["markup.italic"], style: { foreground: colors.markdownEmph, italic: true } },
    { scope: ["markup.list"], style: { foreground: colors.markdownListItem } },
    { scope: ["markup.quote"], style: { foreground: colors.markdownBlockQuote, italic: true } },
    { scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"], style: { foreground: colors.markdownCode } },
    { scope: ["markup.link", "markup.link.url"], style: { foreground: colors.markdownLink, underline: true } },
    { scope: ["markup.link.label"], style: { foreground: colors.markdownLinkText } },
    { scope: ["comment"], style: { foreground: colors.syntaxComment, italic: true } },
    { scope: ["string", "symbol"], style: { foreground: colors.syntaxString } },
    { scope: ["number", "boolean", "constant"], style: { foreground: colors.syntaxNumber } },
    { scope: ["keyword", "keyword.import", "keyword.function"], style: { foreground: colors.syntaxKeyword } },
    { scope: ["operator", "keyword.operator"], style: { foreground: colors.syntaxOperator } },
    { scope: ["function", "function.call", "function.method", "constructor"], style: { foreground: colors.syntaxFunction } },
    { scope: ["variable", "variable.parameter", "property"], style: { foreground: colors.syntaxVariable } },
    { scope: ["type", "class", "module"], style: { foreground: colors.syntaxType } },
    { scope: ["punctuation", "punctuation.bracket", "punctuation.delimiter"], style: { foreground: colors.syntaxPunctuation } },
  ])
}

const [syntaxStyle, setSyntaxStyle] = createSignal(buildSyntax(ristretto))
/** Markdown/code SyntaxStyle for the active theme; call it inside JSX so it tracks theme changes. */
export const syntax = syntaxStyle

/** Swap the whole palette (theme switcher / config). */
export function applyTheme(colors: ThemeColors) {
  setThemeStore(reconcile({ ...colors }))
  setSyntaxStyle(buildSyntax(colors))
}
