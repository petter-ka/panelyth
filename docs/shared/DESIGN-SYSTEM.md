# Design System (shared)

The visual system of every app in the product family (ADR-0014, ADR-0025): Tailwind CSS tokens, shadcn/ui-style
primitives, themes, typography, motion rules and the keyboard foundation. App-specific UX:
`docs/viewer/UX-DESIGN.md` and `docs/commander/UX-DESIGN.md`.

Implemented today in `src/viewer/renderer/src/styles/index.css` and `src/viewer/renderer/src/components/ui/`; Stage P01 moves
both into `src/shared/ui`, so the two apps share one source.

## Visual language

Use Tailwind CSS + shadcn/ui.

Prefer:

- compact spacing
- clean typography
- clear selected/focused states
- low-noise surfaces
- consistent icons
- a selectable icon library (Settings → Appearance, shared by both apps through `shared.appearance.iconSet`): the
  built-in line icons (default), Fluent System Icons (MIT) or Material Symbols (Apache-2.0). Chrome icons are drawn by
  the shared `Icon` in `src/shared/ui`; the other two sets are a subset of path data (`iconPaths.ts`), not the whole
  libraries. The colored file-type glyphs (`TypeGlyph`) are not part of the choice.
- restrained motion

Avoid expensive backdrop blur and per-thumbnail animations on the scrolling surface.

## Theme and color

Implemented in `src/viewer/renderer/src/styles/index.css`. Components use token names only (`bg-canvas`,
`bg-chrome`, `text-muted`, `border-border` …), never raw colors.

### Principles

1. **Neutral originals, optional color.** The original Light and Dark themes keep a neutral gray surround
   (the ISO 3664 idea behind darkroom and Lightroom-style interfaces), because a tinted background shifts how
   colors in the photo are perceived. Optional Dark purple, Dark brown, Beige and Light brown themes add a
   restrained tint for people who prefer warmer or more colorful chrome.
2. **Chrome frames, canvas holds content.** Navigation and controls (sidebars, toolbars, pane and panel headers,
   status bars, the commander's function-key bar) sit on *chrome*. The content (the viewer's tiles and preview, the
   commander's file lists, quick view and lister) sits on the darker *canvas*, so the content carries the contrast and
   the interface recedes.
3. **One accent per palette.** The original themes use safelight amber; tinted themes use a matching readable
   accent. It is used only for keyboard focus, selection (selected tiles, marked files) and the single primary action
   in a view, and stays visible when drawn on top of any photo (selection outlines on thumbnails).
4. **Dark by default.** A fresh profile opens in the original Dark theme. Users can choose any palette in
   Appearance settings or follow the system setting, and the choice persists.

### Tokens

| Token | Role | Dark | Light |
|---|---|---|---|
| `canvas` | media field: content body, preview body | `#1b1b1b` | `#e8e8e8` |
| `chrome` | sidebar, toolbars, pane headers, status bar | `#242424` | `#f7f7f7` |
| `raised` | buttons, inputs, menus, popovers | `#2e2e2e` | `#ffffff` |
| `border` | hairline separators between regions | `#3a3a3a` | `#d4d4d4` |
| `text` | primary text | `#e6e6e6` | `#1c1c1c` |
| `muted` | secondary text, metadata, hints | `#a3a3a3` | `#5e5e5e` |
| `skeleton` | loading placeholders | `#2a2a2a` | `#dcdcdc` |
| `accent` | focus ring, selection, primary action | `#f0a23b` | `#8f5200` |
| `accent-foreground` | text on accent | `#1b1b1b` | `#ffffff` |
| `success` / `warning` / `danger` | status only | `#74c886` / `#e3cc6b` / `#ff8a7a` | `#1f7a35` / `#8a6d00` / `#c4291c` |

Text is `#e6e6e6` rather than white in the original Dark theme, which avoids glare next to images in a dark room.
Borders are low-contrast on purpose: they separate regions and carry no meaning.

### Contrast (WCAG 2.x)

`text`, `muted`, `accent` and `danger` reach at least 4.5:1 on `canvas`, `chrome` and `raised`; status colors reach
at least 3:1 (non-text). The keyboard focus ring is a 2px `accent` outline with a 2px offset.

`src/styles/tokens.test.ts` enforces the neutral-gray rule and contrast ratios for the original Light and Dark
themes. The optional palettes keep those contrast targets while adding their surface tints.

### Typography

- Inter and JetBrains Mono are bundled locally in `src/shared/ui/src/fonts`; the renderer makes no external font
  requests. Their SIL Open Font Licenses are included beside the font files.
- Inter Regular (400) is the default for normal text, Inter Medium (500) is used for navigation, and Inter SemiBold
  (600) is used for the app title and buttons. JetBrains Mono is used for paths, IDs, code and numeric values.
- Base 13px. 12px for secondary text and 11px for the status bar.
- Sentence case everywhere. No all-caps section labels.
- Tabular numerals for numbers that update or align (ping, sizes, dimensions, counts).

### Motion and effects

No transitions or animations on the scrolling surface or on tiles. No `backdrop-filter`, shadows or gradients in
the chrome. Motion is reserved for responses to user actions (opening a menu, expanding a tree node) and is
added only with a measured trace (ADR-0014).

Stage 08 motion: menus and dialogs fade and scale in from 98 % over 120 ms (`--motion-fast`, `--motion-ease`) and
close instantly, and the tree chevron rotates when a node expands. Everything is off under `prefers-reduced-motion`.

### Tooltips

Use the shared `Tooltip` component for hover hints, or `data-tooltip-content` directly in virtualized rows. The
app-level `TooltipProvider` shows one theme-aware tooltip after 500 ms on pointer hover or keyboard focus, including
for portalled dialogs. Do not put native HTML `title` attributes on UI elements; component `title` props that render
visible headings or labels are unaffected. Use `side="right"` for left rails and
`data-tooltip-side="right"` for virtualized rows; the tooltip flips if the viewport has no room on that side.

## Keyboard foundation

- Every command key comes from the keymap (ADR-0022). Menus and tooltips show the current key, and **Keyboard
  shortcuts** (F1, Ctrl+/ or the keyboard button in the status bar) lists every command and lets the user record a
  new key or reset to the default.
- Keymap scopes are per app: the viewer has `global` and `viewer`; the commander adds `panels`, `lister` and
  `dialogs` (ADR-0028); the shell adds `shell` for keys that work in both apps (the app switch, Ctrl/Cmd+Shift+M).
  Overrides live in the shared `library.db`, under each app's key and `shared.shortcuts` for the `shell` scope.
- Plain keys (Backspace, Delete, letters) never fire commands while a text field has focus.

## Interface size

Appearance settings offer S / M / L font and spacing sizes. The size scales text, padding and margins across the UI,
while content geometry stays fixed (viewer: thumbnail dimensions; commander: row height per size is fixed for the
virtualizer). Theme and interface size are shared by both apps (`shared.appearance` in `library.db`, ADR-0031); each
app view keeps a local mirror so the value applies before the first render, and a change in one app reaches the
other at once.

The interface language is part of the same value (ADR-0034): English (the default), Hungarian, Spanish, Italian,
French, Polish, Russian or German, chosen in Settings → Appearance → Language and applied to both apps and to the
document window. Every user-visible sentence goes through `t()` from `@panelyth/i18n`; text is never assembled from
translated pieces, and a new message needs a translation in each language file (the catalog test fails otherwise).

## App switch rail

The apps meet in a shared left rail (ADR-0031, `docs/shared/APP-SWITCHING.md`). The same `src/shared/ui` component keeps
its placement and behavior consistent in both apps:

- 44 px wide, full height, with Viewer above Commander; each gets an 18 px glyph in a 36 × 36 px button;
- `chrome` surface with a border; the current app uses `raised` and `accent`, while the other app is muted and uses
  `raised` on hover; the global 2 px `accent` focus ring applies;
- the inactive app's tooltip shows "Switch to Commander (Ctrl+Shift+M)" or "Switch to Viewer (Ctrl+Shift+M)" with
  the current keymap chord; its accessible name omits the key and `aria-keyshortcuts` exposes it;
- the selected app has `aria-current="page"` and is disabled; switching apps has no transition;
- packaged builds show the rail; unpackaged builds can hide it with the commander feature flag. It is unavailable
  behind a modal dialog's backdrop.
- a Settings button sits at the bottom of the rail in both apps; shared settings appear in both dialogs and the
  active app's own settings appear only in its dialog.
