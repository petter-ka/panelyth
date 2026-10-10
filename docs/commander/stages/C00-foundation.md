# Stage C00 — Commander Foundation and the App Switch

Status: **Complete** (2026-10-05). Track: commander.
Depends on: P01 (the minimal part done the same day). Unblocks: C01.

## Objective

The commander as a second app view in the Panelyth shell, reachable from the viewer through the switch icon at the
top (and back), with the dual-panel shell (empty panels, function-key bar) and shared appearance. It is measured from
day one, and the viewer stays as fast as before.

## Decisions applied

- **ADR-0031:** one shell, one window, one app view per app, one sidecar; the switch icon and key.
- **ADR-0027:** the commander capability profile for its app view (shared methods only in this stage).
- **ADR-0028:** the panel layout (shell only; lists arrive in C01).
- ADR-0014 and `docs/shared/DESIGN-SYSTEM.md`: tokens, themes, interface size, the app switch control.

## Scope

- **Commander app view:** `src/commander/renderer` and `src/shared/desktop/src/preload/commander.ts`; the commander's
  capability profile in main; the view is created on the first switch and then kept alive hidden
  (`docs/shared/APP-SWITCHING.md`).
- **Commander UI:**
  - AppShell: the app bar (the switch icon only, for now), `PanelPair` with two empty panels (header, "No folder"
    state), the resizable divider (persisted under `commander.layout`), the function-key bar (labels and buttons;
    actions not built yet are disabled with a tooltip) and a status bar (sidecar state, keyboard-shortcuts button);
  - Tab switches the active panel; Alt+F4 exits;
  - the shared keymap engine with the commander scopes, and the shared settings dialog (Appearance tab).
- **The switch, in both apps** (`docs/shared/APP-SWITCHING.md`):
  - the switch icon at the top left of the viewer's navigation toolbar and of the commander's app bar, on the same
    spot;
  - Ctrl/Cmd+Shift+M (`app.switch` in the `shell` scope);
  - window title per app; focus on the target's main surface; disabled behind modal dialogs;
  - feature flag: on in development builds and with `PANELYTH_COMMANDER=1`, off for users until Stage C11.
- **Shared appearance:** theme and interface size move to `shared.appearance` (migrating the viewer's current values)
  and apply live in both apps.
- **Tooling:** `pnpm dev`, `pnpm build` and `pnpm test:e2e` include the commander renderer; `launchApp({ app:
  "commander" })` starts with the commander shown.

## Non-goals

- Carrying the folder, focus and selection over (Stages C01 and C02); listings (C01); the keyboard model (C02); file
  operations (C04).

## APIs/contracts

- `app.switch` and `app.visibility` from P01, now in both profiles. No new sidecar methods.

## Tests

- Renderer: the commander AppShell renders two panels; Tab moves the active panel; the divider persists; the switch
  button shows the other app's glyph, tooltip and shortcut.
- E2E (`src/shared/e2e/specs/commander/foundation.spec.ts`, `src/shared/e2e/specs/switch.spec.ts`):
  - switch viewer → commander → viewer by icon and by key; the commander view is created once; titles and focus
    follow;
  - a theme or interface-size change in one app shows in the other;
  - with the feature flag off, the viewer shows no switch icon and its preload surface is unchanged;
  - each app view's preload surface is exact; a commander-only method called from the viewer view is rejected; no
    `require`, `process` or `ipcRenderer` on `window` in either view.
- The viewer's suites stay green.

## Benchmarks

`BENCH_STAGE=C00`: viewer startup and idle memory with the commander never opened (unchanged); first switch to the
commander (view creation → interactive); later switches; idle memory with both views created.

## Acceptance criteria

- The switch budgets in `docs/shared/APP-SWITCHING.md` pass: first switch < 800 ms, later switches ≤ 1 frame, both
  views < 160 MB idle over empty Electron (recalibrated from 150 MB after measuring; ADR-0031).
- The viewer's startup and idle memory are unchanged while the commander has never been opened.

## Risks

- Keyboard focus can stay in the hidden view after a switch. Covered by e2e: the next key press must reach the visible
  app.

## Results (2026-10-05)

Built:

- `src/commander/renderer` (`@panelyth/commander`): app bar with the switch, two panels (header, active marking, empty
  state), the resizable divider persisted as `commander.layout`, the function-key bar (Exit works; the file commands
  are disabled with a tooltip), and a status bar (backend state, theme).
- `src/shared/desktop`: the commander's preload (`commander.cjs`), the `app://commander` origin, the shell switch
  (`shell.ts`), the feature flag `PANELYTH_COMMANDER=1` (on in `pnpm dev`) and `PANELYTH_START_APP` for tests.
- The viewer: the switch icon first in the navigation toolbar and the `app.switch` keymap action
  (Ctrl/Cmd+Shift+M, also while typing), both only while the commander is enabled.
- `src/shared/ui`: the switch button, and theme and interface size shared through `shared.appearance` (migrated from the
  viewer's local values on first start; live in both apps through the `settings.changed` event).

Deviations from the scope above:

- The commander has a theme toggle in its status bar instead of the shared settings dialog, and its Ctrl/Cmd+Shift+M
  is fixed rather than remappable. Both need the keymap engine and dialogs in `src/shared/renderer-core` (the open part of
  P01).

Tests: contracts 49, desktop 88 (per-view allowlists, `app.switch` validation, shared-setting broadcast), `src/shared/ui`
26, commander 6, viewer 151 + 2 failing (the theme-label tests that already failed), Go all. E2E 48 of 50: the new
`specs/commander/foundation.spec.ts` (2) and `specs/switch.spec.ts` (3) pass; the 2 failures are the existing
`theme.spec.ts` label tests.

Measurements (reference machine; `src/shared/bench/results/stage-C00-2026-10-05-*`):

| Metric | Result | Budget |
|---|---|---|
| First switch to the commander (view created) → panels visible | 92 ms | < 800 ms |
| Later switches (key press → app shown) | 4–6 ms | ≤ 1 frame |
| Viewer ready-to-show p50 / sidecar ready p50 (commander disabled) | 229 / 134 ms | < 1000 / < 500 ms |
| Commander view, idle | +97 MB (one renderer process) | — |
| Both views, idle, over an empty Electron window | ≈ 153 MB | < 160 MB (recalibrated from 150 MB) |

Budget decision (owner, 2026-10-05): keep the hidden view alive and recalibrate the both-views budget to 160 MB
(ADR-0031 open point resolved).

Found while measuring, not caused by this stage: the startup benchmark's idle memory now reads 152.6 MB over empty
Electron (Stage 08: 52.9 MB). Electron's processes are unchanged (±7 MB); the sidecar went from 14 MB to 97 MB because
since Stage 08.5 a fresh profile opens the Home folder at start (folder covers decode images), so the benchmark no
longer measures an empty app. A sidecar started without a folder idles at 1 MB of heap. The benchmark should start
without a folder again (Stage P05).

## Exit checklist

- [x] implementation complete
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed (both-views budget recalibrated to 160 MB)
- [x] docs/ADR updated
