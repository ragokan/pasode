# Sources (2026-10-09)

<!-- Provenance: ~/coding/ocode/SOURCES.md format; source inventory authored for pasode. -->

Adaptations retain a provenance comment in every TypeScript source/test. No source repository or live config was modified.

| Maintained files | Source / changes |
| --- | --- |
| `{index.ts,runtime.test.ts}` | `~/coding/ocode/plugins/ocode/tui.ts` and `setup.ts`; export the components as an array supported by the Paseo loader, rather than duplicating host lifecycle handling. Runtime/effect/slot cleanup regression check authored locally. |
| `usage-sidebar/{tui.tsx,usage.ts,usage.test.ts}` | `~/coding/ocode/plugins/usage-sidebar/{README.md,tui.ts,usage.ts,usage.test.ts}`; retain layout/countdown/expired-window conventions, replace credential readers/cache with Paseo usage signals, or ZeroSub's per-account usage (`zerosub.state` from `@kapybara/zerosub` 1.2.1, read-only; its `StateView` subset is typed locally). |
| `warp/{tui.tsx,payload.ts,transitions.ts,warp.test.ts}` | `~/coding/ocode/plugins/warp/src/{tui.ts,v2.ts,notify.ts,payload.ts,title.ts,constants.ts}` and `tests/*` (Warp MIT); same OSC payload transport, title sanitization, protocol-version negotiation (`negotiateProtocolVersion`) and handshake semantics, Paseo agent transitions and the notification-routing check authored locally. Kaku spinner and on-screen notifications follow ocode `plugins/warp/src/title.ts` at `192d124`. `.tsx` routes Solid hooks through OpenTUI's host-runtime transform even without JSX. |
| `LICENSE` | Combined unchanged MIT permission/warranty text and copyright notices from reference OpenCode `LICENSE` and `~/coding/ocode/plugins/warp/LICENSE`. |
| `AGENTS.md`, `README.md`, `SOURCES.md` | `~/coding/ocode` repository conventions adapted for this plugin folder. |

`warp/payload.ts` follows ocode's `title.ts` for `WARP_TITLE_MAX` and `max - 1` + `"…"` truncation. Local deviation: `truncate` uses `Intl.Segmenter` to preserve whole graphemes.

Reference OpenCode checkout: `~/.cache/paseo-tui-ref/opencode`, HEAD `388406238bd5ca15564a762840a2362c3a45bd9c`, upstream https://github.com/anomalyco/opencode. The sidebar feature plugin sources above are MIT. Reference ocode HEAD: `fd7c24241338ad08e8e66b4c01e7014a10a8f8d6`; source checkout https://github.com/ragokan/ocode. Warp fork provenance: https://github.com/ragokan/opencode-warp, upstream https://github.com/warpdotdev/opencode-warp, original source HEAD `65a41f544af0934641b61a6642083402c3774cc1` plus preserved local modifications (see ocode's `SOURCES.md`).

Observed environment: Bun 1.4.2, OpenTUI 0.5.17, Solid 1.9.12, Paseo client/protocol 0.11.2. Plugin runtime access remains through `ctx`, and `@pasode/host` imports are erased types only.
