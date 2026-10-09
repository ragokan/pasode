# OpenCode themes

Assets are copied unchanged from OpenCode v2.0.26 (`packages/tui/src/theme/assets`):
33 legacy JSON documents and `v2/opencode.json`, which takes precedence over the
legacy document with the same name. This exposes 33 built-in theme names.

Legacy hue migration and OKLCH helpers are ported from `packages/theme/src/tui`.
Resolution follows its mode selection, state expansion, dialog contextualization,
categorical step-200 agent selection, and hue-backed `decrease` behavior. Flat keys
preserve this client's existing API; incomplete palettes retain derived fallbacks.
Logo shadows use `packages/tui/src/theme/color.ts`'s rounded 25% tint.

Upstream: https://github.com/anomalyco/opencode/tree/v2.0.26
MIT license: see `LICENSE`.

`fixtures/monokai-pro-ristretto.json` is the user's V2 palette snapshot, so color
regressions remain testable without their home directory.
