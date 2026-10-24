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

Avoid expensive backdrop blur and per-thumbnail animations on the scrolling surface (in both styles; see "Styles").

## Styles

Three design styles, chosen in Settings → Appearance → Style and shared by both apps
(`shared.appearance.style`, ADR-0041, ADR-0047). They are independent of the theme: every palette below works in
each.

- **Classic** (the default for a fresh profile): the flat, neutral design the rest of this document describes.
  It was the only style before ADR-0041.
- **Liquid glass**: the regions float as rounded, translucent cards with an
  8 px gap over a still wallpaper, which is three soft blooms of the palette's accent, blue and purple over its
  canvas. Edges are lit by a 1 px gradient ring. Menus, popups and dialogs blur what is behind them. Buttons,
  segmented controls and tabs are capsules, and the gap between two cards is the resize handle.
- **Terminal** (ADR-0047): a field operative's console. Square panels with a gap over a still grid, each framed
  with corner brackets in the theme's signal color, monospaced type, scanlines on the title strip and behind
  dialogs. Each theme becomes a console of its own, named so in Settings: Phosphor, Ice, Amber, Dossier, Manila
  and Archive (see "Terminal style" below).

How the glass style is built (`src/shared/ui/src/styles.css`, `:root[data-style="glass"]`):

| Class | Role |
|---|---|
| `glass-shell`, `glass-stack` | app root and stacks: the gap between cards |
| `glass-region` | a card; inside it `--chrome` is clear and `--canvas`, `--raised` and `--border` are translucent, so components keep their token classes. A sticky header inside a card takes an opaque stand-in. `data-glass-overflow="visible"` lets popups reach past the card's edge |
| `glass-float`, `glass-sheet` | menus and popups, dialogs: blurred floating layers |
| `glass-chip` | a layer that stays over the scrolling surface: glass without the blur, denser |
| `glass-pill` | capsule shape for buttons, segmented controls and tabs |
| `glass-press` | a toggle pressed into the glass while `aria-pressed`, or the current app on the rail (`aria-current="page"`, keeping its accent glyph; with `app-icon` it has an app icon's rounded square instead of a capsule): a sunken capsule with a shadowed top edge, a lit lower lip and an accent tint and glow; pressing squishes it a little |
| `glass-gutter`, `glass-gutter-y` | resize handles that are the gap between two cards |
| `glass-page` | a whole window as one card (the settings window) |

- Mark new regions and floating layers with these classes. Over a picture, use `bg-chrome-solid` or
  `bg-canvas-solid` (opaque on glass, the plain surface in classic), never a translucent surface token.
- No `backdrop-filter` on cards, chips or anything on the scrolling surface. The wallpaper behind the cards is
  still and soft, so a blur would change nothing.
- Floating layers are liquid and take the theme's colors: their fill is a soft diagonal gradient through the
  palette's accent, purple and blue (the wallpaper's hues), over a backdrop that is blurred lightly, rippled by
  the `#glass-liquid` SVG filter and tone-mapped so text keeps AA over any picture. In dark palettes the backdrop
  is squeezed into a band of dark grays and the tinted layer is always lighter than the app, so it never looks
  inactive; in light palettes it is lifted to near white, with a gloss across the top. Menus and popups have a
  lighter blur and the stronger `#glass-liquid-strong` ripple. Dialogs sit on a light scrim, so the app reads
  through them.
- Full-window media overlays (image viewer, editor, media window, lister) keep the solid canvas in both styles.
- `tokens.test.ts` checks text, muted, accent and danger at 4.5:1 on the composite colors: cards over the
  wallpaper's strongest colors in every palette, and menus, dialogs and chips over a black and a white picture.

### Terminal style

Built on the glass style's marker classes (`:root[data-style="terminal"]` in `src/shared/ui/src/styles.css`), so a
region or layer marked for the glass gets the terminal's frame too.

- **Palettes:** the style redefines each theme's tokens. Dark consoles (Phosphor, Ice, Amber) draw frames and
  titles in the accent and let it glow; paper (Dossier, Manila, Archive) draws them in the red stamp (`--danger`)
  and has no glow, with ink blue as the accent. `--term-signal` is that color; `--term-line`,
  `--term-line-strong` and `--term-corner` are mixed from it.
- **Surfaces are opaque.** No translucent token and no `backdrop-filter`; effects are static (the grid, frames,
  scanlines) and drawn by pseudo-elements, so the layout never moves.
- **Type:** "Panelyth Terminal" (variable JetBrains Mono, OFL) for `--font-sans` and `--font-mono`; ligatures off.
  Section labels (`h3`, `h4`) and column headers are stencilled (capitals, tracking). Never capitalize a file's
  name: the main window's strip stencils the product's name, a child window's shows its file name as it is.
- **States:** the cursor row of the active panel has a signal tint and a lit bar at its left edge; pressed toggles
  and the chosen option of a segmented choice are in reverse video; the active panel lights its frame.
- **Motion:** menus and dialogs scan in from the top (seven steps, 140 ms); the title strip's cursor blinks. Both
  are off under `prefers-reduced-motion`.
- `tokens.test.ts` checks each console's contrast (the palette, the cursor row, the dialog header, the signal on
  the strip); `specs/style-scroll.spec.ts` measures scrolling in the classic and the terminal style.

## Theme and color

Implemented in `src/viewer/renderer/src/styles/index.css`. Components use token names only (`bg-canvas`,
`bg-chrome`, `text-muted`, `border-border` …), never raw colors.

### Principles

1. **Neutral originals, optional color.** The original Light and Dark themes keep a neutral gray surround
   (the ISO 3664 idea behind darkroom and Lightroom-style interfaces), because a tinted background shifts how
   colors in the photo are perceived. Optional Dark purple, Dark brown, Beige and Light brown themes add a
   restrained tint for people who prefer warmer or more colorful chrome. Settings → Appearance lists them in a
   Dark themes group (Dark, Dark purple, Dark brown) and a Light themes group (Light, Beige, Light brown) under a
   System checkbox; while System is ticked no theme of either group is chosen, and choosing one unticks it.
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
- Captions use the `text-2xs` (11px) and `text-3xs` (10px) tokens, never an arbitrary size. They follow the interface
  size but stop at 10px, the smallest text a desktop interface should show; at the small interface size 11px text
  would otherwise be 9.6px.
- Sentence case everywhere. No all-caps section labels.
- Tabular numerals for numbers that update or align (ping, sizes, dimensions, counts).
- Mono is for what could be typed or what lines up in a column: paths, commands, key caps, the data columns of a file
  list. `tabular-nums` switches to it. A sentence that has numbers in it (a status line, "152 items", "2 of 155
  marked") stays in Inter with tabular figures (`prose-nums`), and a bar uses one text face and one weight.

### Form fields

- Text fields and selects use `fieldClass` or `fieldLook` from `src/shared/ui` (`field.ts`): the `raised` surface, as
  the token table says, so a field is lighter than the chrome around it and an empty field does not look unavailable.
- A field's border is `muted` at 70 %, stronger than a region separator: 3.1:1 on `chrome` in Light and 3.9:1 in
  Dark (`tokens.test.ts`). Focus is the accent border plus a 1px accent ring.
- Fields edited in place on the content (the commander's path, rename and command line) stay on `canvas`.
- Native checkboxes, radio buttons and ranges take the palette's accent (`accent-color`).

### Settings controls

In the settings window (owner request 2026-10-24; `styles.css` "Settings controls", scoped by `.settings-form`):

- Every on/off setting is a switch: the native checkbox (or `SwitchRow`'s `role="switch"` button, `.ui-switch`)
  drawn as a track and a thumb. Off: an outlined track with a muted thumb; on: the accent track with a light thumb,
  as Windows 11 draws them, so both states read in every theme. The thumb slides with a slight overshoot, grows on
  hover and stretches while pressed.
- A checkbox's row starts with the switch, then the label. A radio takes a switch's width with its dot in the middle,
  so the controls form one column on the left and every label starts at the same place (owner request).
- A one-of choice is a list of rows with a dot: the row is the target and highlights on hover; the chosen one is
  tinted in the accent with a filled dot.
- The native inputs stay, so keyboard, labels and screen readers work as before. Motion is off under
  `prefers-reduced-motion`; the terminal style squares them.

### Segmented control

`ChoiceGroup` (settings) and the viewer's tile size control mark the chosen segment the same way: it is filled with
`raised` and the others are `muted` text with no border of their own. `ChoiceGroup` sits on a `canvas` track. The
accent is not used: a filled segment already says which one is chosen. Use it for a few exclusive values, or to switch
the sections of one settings tab.

### Motion and effects

No transitions or animations on the scrolling surface or on tiles. In the classic style, no `backdrop-filter`,
shadows or gradients in the chrome; the glass style's exceptions are in "Styles" above (ADR-0041). Motion is reserved for responses to user actions (opening a menu, expanding a tree node) and is
added only with a measured trace (ADR-0014).

Stage 08 motion: menus and dialogs fade and scale in from 98 % over 120 ms (`--motion-fast`, `--motion-ease`) and
close instantly, and the tree chevron rotates when a node expands. In the glass style they pop from 96 % over
200 ms with a slight overshoot (`--motion-pop-from`). Everything is off under `prefers-reduced-motion`.

### Menus

- Every menu is drawn at the top level of the page, over the panels, the cards' edges and the bars, and never
  under what is below the thing that opened it. The shared Radix menus (`src/shared/ui/src/menu.tsx`) are
  portalled; the commander's keyboard-first `PopupMenu` keeps a zero-size anchor where its caller puts it and draws
  itself at the top level (`z-index: 60`, above dialogs).
- A menu stays within the window, 8 px from its edges. It opens below its anchor or the pointer when it fits, above
  it when only that fits (as a native menu does near the bottom of the screen), and otherwise from the top of the
  window, as tall as the window allows, scrolling. Submenus follow the same rules.
- `e2e`: `specs/commander/menus.spec.ts` and `specs/viewer/menus.spec.ts` check that nothing covers a menu and that
  it fits and scrolls in a small window.

### Loading states

Nothing that is loading is shown as an empty surface (`src/shared/ui/src/AppLoading.tsx`).

- `LoadingIndicator`: a ring and "Loading…" on a small capsule. Over an empty canvas it shows at once (stepping
  through pictures remounts the view, so a delayed indicator would never get to show). Over something already
  shown, such as a thumbnail or a video poster, it fades in after 180 ms (`.pending-fade`), so a load that answers
  at once never flashes it.
- Image viewer: the capsule in the middle while nothing is decoded, or a ring in the bottom-right corner over the
  tile thumbnail until the sharp picture is in. Video player: the capsule while the file is prepared, after Play
  until the first frame, and while playback waits for data. It never shows together with the Play button.
- The app's loading screen and the boot screen are described in `docs/shared/APP-SWITCHING.md` ("Loading
  screen").

### Tooltips

Use the shared `Tooltip` component for hover hints, or `data-tooltip-content` directly in virtualized rows. The
app-level `TooltipProvider` shows one theme-aware tooltip after 500 ms on pointer hover or keyboard focus, including
for portalled dialogs. Do not put native HTML `title` attributes on UI elements; component `title` props that render
visible headings or labels are unaffected. Use `side="right"` for left rails and
`data-tooltip-side="right"` for virtualized rows; the tooltip flips if the viewport has no room on that side.

### Editor controls (viewer, Stages 12 to 15)

The image editor's controls live in `src/viewer/renderer/src/components/editor/controls.tsx`; they move to
`src/shared/ui` only if the commander needs them (ADR-0035).

- **Slider:** a track (a native range input, so arrows step by one, Page keys by more, Home and End jump), a number
  field and a reset dot. Double click or Ctrl/Cmd+0 resets. The number field takes typed values with their unit
  (`7,5°`, `50 %`, `200 px`) on Enter or blur; arrow keys step it, Shift by ten. The value is spoken with its unit
  (`aria-valuetext`).
- **Segmented control** for a few exclusive choices; **select** for more; a **fill field** (a color, or a named fill
  such as transparent or edge).
- **Canvas:** the picture sits on a neutral surround, 18 % gray (`#777777`) in both themes so colors are judged the
  same way; Settings → Viewer → Image editor offers black, white or the theme's tone instead. What is transparent is
  shown on a light checkerboard. No effects on the canvas.
- **Progress:** a 2 px accent line under the toolbar for renders longer than 200 ms, pulsing in opacity (still under
  `prefers-reduced-motion`). The canvas never goes blank: the last frame stays until the next has loaded.
- **Gesture tools** (crop) show Apply and Cancel and take Enter and Esc; tools with parameters apply as they change
  and sit in the edit stack.
- **Tool groups (Stage 13):** the rail holds groups, not tools: one tab stop, arrow keys between the groups, a key
  per group. The panel lists the group's tools as headers (`aria-expanded`); one is open at a time.
- **Curve widget:** a square canvas (grid, the incoming histogram, the curve) with the control points as buttons
  over it, so Tab walks them and each has its values as its name. Click adds, drag moves, arrows nudge (Shift: by
  ten), Delete removes; two number fields edit the selected point. The curve takes the channel's color; no fill.
- **Eyedropper and loupe:** a crosshair cursor over the picture and a bordered box beside the pointer with the
  pixels at 8× (crisp, a white square marks the centre), a swatch, the hex value and R, G, B. Arrow keys move the
  point, Enter takes the color, Esc cancels. The armed button is `aria-pressed`.
- **Swatches:** squares in a grid of eight with a border; the tooltip gives the hex value and the share, a click
  copies the value.
- **Look tiles:** a 4:3 thumbnail of the current picture with the look's name under it, two per row.
- **Regions and points on the canvas (Stage 14):** a box with eight handles (the ellipse is the same box with
  round corners), polygon points and the lens centre are buttons: drag, or arrow keys for one picture pixel (ten
  with Shift), Delete for a polygon point. Strokes are a white line with a black outline, so they show on any
  picture; a lens ring is not interactive. Nothing on the canvas animates.
- **Picked picture:** a 48 px thumbnail on the canvas tone, the file's name and size beside it, and a button that
  opens the native dialog. The name is all the interface knows of the file.
- **Position grid:** nine radio buttons with arrows (the canvas-size anchor grid), for where a mark sits.
- **Token chips:** small rounded buttons under a text field that insert `{token}` at the caret.
- **Painting on the picture (Stage 15):** the pointer is a ring of the brush's size (white with a black outline;
  a crosshair for text, fill and red-eye). The stroke in progress is drawn at once in the brush's color and
  opacity; an eraser, clone or heal stroke as a translucent white path; a red-eye box dashed. With the keyboard a
  small cross moves by the arrow keys and Enter acts there. A tool's panel has a "By numbers" section for
  everything that is not a free-hand stroke, and says when a pointer is needed.
- **The editor keeps the keyboard:** what is behind it cannot take the focus, and a key pressed while the focus
  is on the page itself still reaches it.

## Keyboard foundation

- Every command key comes from the keymap (ADR-0022). Menus and tooltips show the current key, and **Keyboard
  shortcuts** (F1, Ctrl+/ or the keyboard button in the status bar) lists every command and lets the user record a
  new key or reset to the default. Reset is shown only for a command whose key was changed.
- Keymap scopes are per app: the viewer has `global`, `viewer` and `editor` (the image editor, Stage 12); the commander adds `panels`, `lister` and
  `dialogs` (ADR-0028); the shell adds `shell` for keys that work in both apps (the app switch, Ctrl/Cmd+Shift+M).
  Overrides live in the shared `library.db`, under each app's key and `shared.shortcuts` for the `shell` scope.
- Plain keys (Backspace, Delete, letters) never fire commands while a text field has focus.

## Interface size

Appearance settings offer S / M / L / XL font and spacing sizes (a 14 / 16 / 18 / 20 px root). The size scales text,
padding and margins across the UI, while content geometry stays fixed (viewer: thumbnail dimensions; commander: row
height per size is fixed for the virtualizer). Geometry that layout math depends on (the commander table's header
height and row gutter) is set in px, never in rem, so it cannot drift from the math at another size. Style, theme and interface size are shared by both apps (`shared.appearance` in `library.db`, ADR-0031); each
app view keeps a local mirror so the value applies before the first render, and a change in one app reaches the
other at once.

The interface language is part of the same value (ADR-0034): English (the default), Hungarian, Spanish, Italian,
French, Polish, Russian or German, chosen in Settings → Appearance → Language and applied to both apps and to the
document window. Every user-visible sentence goes through `t()` from `@panelyth/i18n`; text is never assembled from
translated pieces, and a new message needs a translation in each language file (the catalog test fails otherwise).

## App switch rail

The apps meet in a shared left rail (ADR-0031, `docs/shared/APP-SWITCHING.md`). The same `src/shared/ui` component keeps
its placement and behavior consistent in both apps:

- 44 px wide, full height, with Viewer, Commander and System (ADR-0042) from the top; each gets an 18 px glyph
  in a 36 × 36 px button;
- `chrome` surface with a border; the current app has an `accent` glyph and a light on the rail's left edge (a
  3 px `accent` tube, brightest in the middle and fading at both ends, with a glow that follows the fade;
  `.rail-light`), so it reads at a glance; in the glass style its button is also pressed into the glass
  (`glass-press`); the other app is
  muted and uses `raised` on hover; the global 2 px `accent` focus ring applies;
- the inactive app's tooltip shows "Switch to Commander (Ctrl+Shift+M)" or "Switch to Viewer (Ctrl+Shift+M)" with
  the current keymap chord; its accessible name omits the key and `aria-keyshortcuts` exposes it; System's icon has
  no key ("Switch to System"), and in System neither other icon has one;
- the selected app has `aria-current="page"` and is disabled; switching apps has no transition;
- packaged builds show the rail; unpackaged builds can hide it with the commander feature flag. It is unavailable
  behind a modal dialog's backdrop.
- a Settings button sits at the bottom of the rail in both apps; shared settings appear in both dialogs and the
  active app's own settings appear only in its dialog.

## App icon

One icon for the product: the shell that hosts both apps. `scripts/icons.mjs` (`pnpm icons`) draws it and writes
every file made from it, so a change goes into the script and never into the files.

- **The mark:** an isometric block, the shell that hosts both apps (and the "-lyth", a stone, in the name), drawn
  in flat-shaded polygons. Its top is a sheet of white paper that is an eye: the diamond of the top is the eye's
  lids, and a gem-cut iris lies in the top's own plane, its facets green toward the light and blue away from it,
  with a small diamond (the top's own shape) for a catchlight. Its two sides are the two panels, the viewer's green
  (`#3ff0a0` to `#0f9d62`) on the left and the commander's blue (`#3d86ff` to `#1a3fb8`) on the right, with light
  file rows across them.
- **Light** falls from the top left: the top is brightest, the green side lit, the blue side in shade. The three
  front edges are chamfered and catch the light (mint, pale blue and a teal strip down the front), the back corner of
  the top is cut by as much, so no corner of the outline is sharp, a fine grey-blue
  rim keeps the top's back edges on a white page, and every element keeps to the isometric axes. The mark stands
  free on Windows and Linux, over a soft shadow on the ground, and sits on a dark tile on macOS.
- **Small drawing:** up to 32 px (the taskbar, the menu bar) the mark is drawn again with wider chamfers, a plain
  teal iris with its pupil and catchlight, bare panels and no shadow, because facets, rows and soft shadows turn
  into a smudge in a 16 px slot.
- **Drawings** in `src/shared/desktop/build`: `icon.svg`, the mark, for Windows, Linux and the window icon;
  `icon-small.svg`, the small drawing; and `icon-mac.svg`, the mark on the macOS tile (824 px on a 1024 px canvas,
  corner radius 184).
- **Files:** `icon.png` (1024 px, the window icon on macOS and Linux), `icons/*.png` (Linux, 16 to 1024 px),
  `icon.ico` (16 to 256 px at the scales Windows asks for; also the window icon on Windows, so the taskbar gets the
  size drawn for its slot rather than the 1024 px picture scaled down) and `icon.icns` (the full Retina set); `mark.svg` and `showcase/src/media/mark.svg` are
  the mark for pages.
- The rail's app glyphs are interface icons, not the app icon: they follow the icon set and the theme.
