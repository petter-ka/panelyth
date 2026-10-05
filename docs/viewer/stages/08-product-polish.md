# Stage 08 — Product Polish + Extensibility Foundations

Status: **Implementation complete — tests pending** (2026-10-01). By request, this step added no new automated tests.
The existing suites pass, but the stage gate ("automated tests exist, failure paths are covered") is open until
tests for the new behaviour are written (see "Tests to add").

## Objective

Refine the design system and lay the data and architecture foundations for later product features without costing
anything on the scrolling surface.

## Already delivered

- Tailwind design tokens and the dark/light themes, with dark as the default (after Stage 00; see
  `docs/shared/DESIGN-SYSTEM.md` "Theme and color" and ADR-0014). Stage 08 refines rather than introduces them.
- Persisted pane layout, tile size and sort (Stage 05).

## Decisions applied

- **ADR-0022** (new): keymap, color labels, collections, image edit lists and viewer transforms.
- **ADR-0014** (unchanged rules): motion only on portalled chrome and in direct response to user actions, never on
  tiles. No new dependencies.

## Scope delivered

| Stage plan item | Implementation |
|---|---|
| Tailwind design tokens | `--label-*` (7 colors × 2 themes) and `--motion-fast` / `--motion-ease` in `styles/index.css`. The existing neutrality/contrast checks (`tokens.test.ts`) pass with the new set |
| shadcn/ui primitives | `components/ui/button.tsx`: `Button` and `buttonClass` (primary / secondary / danger / toolbar × md / sm / icon, the looks already in use) and `Kbd`. `JobDialogs` uses them. `DialogWindow` forwards `onEscapeKeyDown` |
| dark/light themes | Already delivered. Label colors are defined for both |
| accessible focus/navigation | **F6 / Shift+F6** cycle focus between the Locations, Content and Preview landmarks, landing on the tree or the tile view (`features/workspace/paneFocus.ts`). New icon buttons have accessible names, and the flip toggle uses `aria-pressed` |
| subtle motion | Menus and dialogs fade/scale in over 120 ms (`.motion-pop`, `.motion-fade`, enter only), and the tree chevron rotates on expand. All of it is off under `prefers-reduced-motion`. Nothing on tiles |
| persisted layout | Already delivered; video volume and mute now persist too (setting `player`, debounced, flushed on exit) |
| custom shortcut foundation | `features/shortcuts/keymap.ts` (27 actions, chord grammar, validated overrides, conflict resolution, display) and `shortcutStore.ts` (library.db setting `shortcuts`). The global handler and the viewer dispatch through it. Menus, toolbar and viewer tooltips show the current chord. A **Keyboard shortcuts** dialog (F1, Ctrl+/, status bar button) lists all actions and records or resets chords |
| color labels foundation | `library.db` migration 3 (`items.label`), `library.SetLabel`, `label` job kind (Go, contracts, main validation, preload), `label` on page rows and properties. Tile badge dot, **Label** submenu in the tile menu, Properties row |
| collection/albums data-model foundation | Migration 3 `collections` and `collection_items` (by `path_key`). `library` store API (`Collections`, `CreateCollection`, `RenameCollection`, `DeleteCollection`, `AddToCollection`, `RemoveFromCollection`, `CollectionKeys`). Membership follows moves and renames (`Rekey`) and is dropped on permanent delete (`Forget`). No RPC or UI yet (model-ready) |
| image transform/effects architecture | `internal/imaging/transform.go`: `EditList` of rotate / flip / crop / resize / effect, `Validate`, `OutputSize`, `Key` (cache-key form, versioned), pure-Go `Apply`, an `Effect` registry with `grayscale` as the reference |
| resize/crop/rotate-ready viewer abstractions | `features/viewer/transform.ts` (`ViewTransform`, `CropRect`, `rotateBy`, `flipHorizontal`, `orientedSize`, `cssTransform`, `toEditList`). `ImageViewer` takes a `transform` and fits, clamps and pans in oriented space. The focused viewer has rotate left/right (Shift+R / R) and flip (H) |

## Measurements

| Check | Result |
|---|---|
| Tile scroll (e2e, unchanged spec) | 100k medium 1920 px: p95 frame 7 ms, 0 long tasks, ≤ 60 tiles; small 2560 px: p95 7 ms, 0 long tasks, ≤ 180 tiles; first thumbnail 186 ms (`stage-03-2026-10-01-e2e-tiles.jsonl`, 09:29Z rows) |
| Startup / memory | `shared/bench/results/stage-08-2026-10-01-petter-startup.json`: ready-to-show p50 222 ms, sidecar ready p50 124 ms, ping p95 0.3 ms, exit p95 17 ms, idle 352 MB, **+52.9 MB over the Electron floor** (budget 60; Stage 06: 56.7). All budgets pass |
| Regression suites | Go all packages; renderer 157, desktop 84, contracts 47; e2e 41/41 |

## Performance rule

> No decorative effect may be added to the scrolling surface without measuring its impact.

None was added. The label dot sits inside the existing badge, only for labelled items. Motion is limited to
portalled menus and dialogs and the tree chevron. The tile scroll measurement above is unchanged from Stage 06.

## Tests to add (deferred by request)

- `keymap.ts`: chord parsing and normalisation (Shift on symbols, `Plus`), `parseOverrides` with hostile input,
  conflict resolution (an override steals a default), `chordAllowedWhileTyping`, `formatChord` on macOS and others.
- Global shortcuts: an overridden chord fires, the old default no longer does, and typing still blocks plain keys.
- Viewer: R / Shift+R / H change `data-rotate` / `data-flip`; fit uses the oriented size; the transform resets on
  the next image.
- `library`: migration 2 → 3 keeps data; `SetLabel` and pruning; collection CRUD and limits; `Rekey`/`Forget` of
  memberships (file and folder).
- `jobs`: a `label` job end to end; the validator rejects 8 and -1.
- `imaging`: `Validate` errors, `OutputSize` against `Apply`, crop rounding, rotate/flip composition, `Key` stability.
- `paneFocus`: cycling skips collapsed panes. Volume persistence round trip.

## Risks and follow-ups

- Chords recorded for keys the tile view handles itself (arrows, Enter, Ctrl+A) are shadowed there. The dialog should
  warn about this.
- The preview pane doesn't rotate yet. Label filters and sorting, the collections UI and RPCs, and edited-preview
  profiles and export are follow-ups (ADR-0022 "Consequences").
- Carried over from Stage 07: the intermittent modernc SQLite fault (see `docs/viewer/stages/07-batch-and-metadata.md`).

## Exit checklist

- [x] implementation complete
- [ ] tests complete (deferred by request; list above)
- [x] benchmark complete
- [x] performance regression reviewed
- [x] docs/ADR updated
