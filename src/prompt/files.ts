import { daemon } from "../paseo"

export type FileSuggestion = { path: string; kind: "file" | "directory" }

/** Files and directories under `cwd` matching `query`, as the Paseo app's "@" completion asks for them. */
export async function suggestFiles(query: string, cwd: string): Promise<FileSuggestion[]> {
  const result = await daemon.getDirectorySuggestions({ query, cwd, includeFiles: true, includeDirectories: true, matchMode: "fuzzy", limit: 20 })
  if (result.error) throw new Error(result.error)
  // Older daemons answer with `directories` only.
  return result.entries?.length ? result.entries : result.directories.map((path) => ({ path, kind: "directory" as const }))
}
