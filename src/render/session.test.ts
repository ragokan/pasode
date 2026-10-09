// Bun's top-level preload does not apply to tests; load the Solid transform before JSX.
import "@opentui/solid/preload"

await import("./session-cases")
