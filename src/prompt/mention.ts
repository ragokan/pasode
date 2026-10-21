// Ported from Paseo's app utils/file-mention-autocomplete.ts: "@" + a query, completed with a path from the daemon.

const INVALID_QUERY = /[\s"'<>]/

/** The "@query" being typed before the cursor: an "@" at the start or after a non-word character (not an email address). */
export function mentionTrigger(beforeCursor: string) {
  for (let index = beforeCursor.lastIndexOf("@"); index >= 0; index = index === 0 ? -1 : beforeCursor.lastIndexOf("@", index - 1)) {
    if (index > 0 && /[\w+]/.test(beforeCursor[index - 1]!)) continue
    const query = beforeCursor.slice(index + 1)
    if (!INVALID_QUERY.test(query)) return { index, query }
  }
}

/** What replaces "@query": the Paseo app inserts the cwd-relative path in double quotes. */
export const quoteMention = (relativePath: string) => `"${relativePath.replace(/"/g, '\\"')}"`
