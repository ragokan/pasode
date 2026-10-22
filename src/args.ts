// pasode's command line: these forms only; anything else is a usage error, before the daemon or the TUI start.

const UUID = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

/** A Paseo agent ID (a UUID) or a prefix of one at least as long as the 7 characters `paseo ls` prints. */
export const isSessionId = (value: string) =>
  value.length >= 7 && value.length <= UUID.length && [...value].every((char, i) => (UUID[i] === "-" ? char === "-" : /[0-9a-f]/.test(char)))

export type Invocation = { run: "tui"; session?: string } | { run: "help" | "version" | "update" | "usage" }

export function parseArgs(args: string[]): Invocation {
  const [first, second, ...rest] = args
  if (first === undefined) return { run: "tui" }
  if (first === "-s" || first === "--session") return second !== undefined && !rest.length && isSessionId(second) ? { run: "tui", session: second } : { run: "usage" }
  if (second !== undefined) return { run: "usage" }
  if (first === "-h" || first === "--help") return { run: "help" }
  if (first === "-v" || first === "--version") return { run: "version" }
  if (first === "update") return { run: "update" }
  return isSessionId(first) ? { run: "tui", session: first } : { run: "usage" }
}
