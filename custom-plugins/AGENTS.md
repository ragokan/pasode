# custom-plugins

<!-- Provenance: local working agreements adapted from ~/coding/ocode/AGENTS.md. -->

- Local Paseo terminal plugins; `index.ts` is the consolidated entry. Component sources and Bun tests live beside each plugin.
- Bun 1.4.4 + the host (`..`) OpenTUI 0.5.17/Solid installation. Run `bun test` and `bun run typecheck` from the host; do not add plugin-only dependencies.
- Import `@pasode/host` for types only. Runtime plugins use `ctx`, never import host internals; Solid/OpenTUI are supplied by the host's runtime loader.
- Keep the sidebar frame, navigation, provider authentication and MCP writes in the host. Preserve disabled MCPs and provider choices.
- Retain per-source provenance and update `SOURCES.md`. Never commit credentials, config, sessions, logs, node_modules, generated output or symlinks.
- Verification includes a runtime-loader import and, when available, an actual terminal render. Report unverified integration behavior explicitly.
- Commit locally after verification; no remote or push unless requested.
