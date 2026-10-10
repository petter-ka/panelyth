# ADR-0022 — Extensibility Foundations: Keymap, Color Labels, Collections, Image Transforms

## Status

Accepted (Stage 08). It extends ADR-0021 (user metadata in `library.db`) and ADR-0014 (design system).

Amended 2026-10-05: keymap scopes are per app. The commander adds `panels`, `lister` and `dialogs` (ADR-0028), the
shell adds `shell` (the app switch, ADR-0031), and the overrides of both apps live in the shared `library.db` under
their own keys.

## Context

Stage 08 asks for foundations that later features build on: custom shortcuts, color labels, collections/albums, an
image transform/effects architecture and rotate/crop-ready viewer abstractions (BRS §9, FEATURE-MATRIX). Each needs a
data shape that later features can extend without migrations or contract breaks, and none may cost anything on the
scrolling surface.

## Decision

### Keymap (renderer, `features/shortcuts/keymap.ts`)

- Every remappable command is an **action** with an id (`nav.back`, `item.trash`, `viewer.rotateCw` …), a scope
  (`global` or `viewer`), a group, a label and default chords (plus macOS-only extras such as Cmd+Backspace for trash).
- **Chords** are strings: modifiers in the order `Mod`, `Alt`, `Shift`, then the `KeyboardEvent.key` name (letters
  lowercase, `+` spelled `Plus`). `Mod` is Ctrl or Cmd. Shift is not part of a chord for symbol keys, because the
  symbol already encodes it.
- **Overrides** are stored in `library.db` as the setting `shortcuts` (`{ v: 1, bindings: { [action]: chords[] } }`),
  validated on load. An override replaces that action's defaults, and an empty list unbinds it. Within a scope a chord
  belongs to one action: overrides claim chords first and defaults fill in the rest.
- **While typing**, only actions marked `whileTyping` fire, and only with a chord that has Mod or Alt or is a function
  key. Plain keys (Backspace, Delete, letters) stay with the text field.
- Menus, toolbar tooltips and the viewer show the **current** chord, so a remap is reflected everywhere.
- Tile-view navigation (arrows, Enter, Ctrl+A, type-to-select) stays fixed in the foundation.
- The shortcuts dialog (F1, Ctrl+/, or the keyboard button in the status bar) lists every action and can record a
  new chord or reset to the default.
- **Shared engine (Stage C02, 2026-10-05):** the engine (chords, override validation, resolution per scope, display)
  lives in `src/shared/renderer-core/src/keymap.ts` and the dialog in `src/shared/ui` (`ShortcutsDialog`); each app keeps its
  own registry and scopes (viewer: `global`, `viewer`, setting `shortcuts`; commander: `shell`, `panels`, setting
  `commander.shortcuts`). Numeric-keypad keys are their own chords — `Num+`, `Num-`, `Num*`, told apart by
  `KeyboardEvent.code` — so the commander's Total Commander keys (Num+ mark by mask, Num* invert) never collide with
  `Plus`, `-` or `*` on the main keyboard.

### Color labels (`library.db` migration 3)

- `items.label INTEGER 0..7`. The value is the 1-based index into `COLOR_LABELS` (red, orange, yellow, green, blue,
  purple, gray), so **the order is contract**. 0 means no label. An item with no favorite, rating, label or tags is
  still pruned.
- Labels are set by a `label` job (the same coalesced, chunked path as rating). They appear on page rows and in
  properties. Tiles show a dot inside the existing badge, so tile geometry is unchanged.
- Colors are theme tokens (`--label-*`), defined for both themes. Query filters and sorting by label are deferred.

### Collections (`library.db` migration 3)

- `collections (id, name, name_fold UNIQUE, position)` and `collection_items (collection_id, path_key, position)`.
  Membership is keyed by `path_key`, separately from `items`, so a file in an album keeps its membership after its
  favorite, rating, label and tags are cleared.
- `library.Rekey` moves memberships with a file or folder (the same transaction as annotations), and `library.Forget`
  drops them on permanent delete. Trash keeps them, as it does annotations.
- Stage 08 delivers the store API (`Collections`, `CreateCollection`, `RenameCollection`, `DeleteCollection`,
  `AddToCollection`, `RemoveFromCollection`, `CollectionKeys`). RPCs, a sidebar section and query scope come with the
  collections feature (FEATURE-MATRIX: model-ready).

### Image transforms and effects (Go, `internal/imaging/transform.go`)

- An **edit list** is a non-destructive, ordered list of operations: `rotate` (90/180/270 clockwise), `flip` (h/v),
  `crop` (a rectangle normalized to the image at that step), `resize` (downscale to a max edge) and `effect` (a
  registered `Effect` with JSON parameters). Effects keep the image size and must be deterministic.
- It runs after decode and EXIF orientation, on `*image.RGBA`, in pure Go (ADR-0019). `OutputSize` predicts the result
  without pixels, for layout and memory budgets.
- `Key()` (`edit<version>:<canonical JSON>`) joins the preview cache key (CACHE-DESIGN `transformVersion`), so an edited
  image never reuses an unedited preview. `EditListVersion` changes whenever an operation's output changes.
- Files are never modified. Export or "save as" is a future feature that renders through the same pipeline.
- `grayscale` is the reference effect. Nothing in the product creates edit lists yet.

### Viewer transforms (renderer, `features/viewer/transform.ts`)

- `ViewTransform { rotate, flipH }` is in screen space: "rotate right" always turns clockwise on screen, and "flip"
  always mirrors left-right. Fit, clamping and panning use the oriented size, while the layered image box keeps its
  logical size and rotates inside it, so layer swaps still never move pixels.
- The focused viewer offers rotate left/right (R, Shift+R) and flip (H). It is display-only and resets per image.
  `toEditList` maps a view transform, plus a future `CropRect`, onto the Go edit list.

## Consequences

- `ContentItem` and `Properties` gain `label`, and `JobKind` gains `label`. The golden fixtures were regenerated.
- Volume and mute now persist (setting `player`), which closes a Stage 06 follow-up.
- A custom chord that collides with a tile-view key (for example Enter) is still captured by the tile view first,
  because the tile view handles its own keys before the window. The dialog doesn't warn about this yet.
- Rotation in the preview pane, label filters and sorting, the collections UI and an edited-preview profile are
  follow-ups. Each needs only wiring, with no schema change.
