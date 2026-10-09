import type { PromptSubmit } from "./types"

export function shellTransition(mode: PromptSubmit["mode"], text: string, key: string): PromptSubmit["mode"] | undefined {
  if (text) return
  if (mode === "normal" && key === "!") return "shell"
  if (mode === "shell" && key === "backspace") return "normal"
}
