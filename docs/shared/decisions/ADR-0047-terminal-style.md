# ADR-0047 — Terminal Style

## Status

Accepted (2026-10-24), at the owner's request, outside the stage list, like ADR-0041 and ADR-0045. Amends
ADR-0041 (`shared.appearance.style` gains a third value) and, like it, ADR-0014 (a few static effects in the
chrome, measured below).

## Context

- The owner asked for a new design for the whole app "like a James Bond spy UI, or Mr Robot, or something like a
  hacker's", with a very good UI and UX, and for the old designs to stay.
- The style mechanism of ADR-0041 already separates the design style from the palette: `data-style` on `<html>`,
  the marker classes (`glass-region`, `glass-float`, `glass-sheet`, `glass-chip`, `glass-pill`, `glass-press`,
  `glass-gutter`, `glass-shell`, `glass-stack`), the setting shared by both apps and the boot script that applies
  it before the first paint.
- The viewer's canvas is where pictures are judged (ISO 3664); the tile view and the commander's lists are the hot
  paths (`docs/shared/PERFORMANCE.md`).

## Decision

- **A third design style:** `shared.appearance.style` is `"classic"`, `"glass"` or `"terminal"`. Settings →
  Appearance → Style offers Classic, Liquid glass and Terminal. Classic stays the default. All of it is CSS
  under `:root[data-style="terminal"]` in `src/shared/ui/src/styles.css`, keyed on the same marker classes, so no
  component changed for it (the title strip got class hooks: `title-bar-name`, `title-bar-detail`,
  `title-bar-mark-img`).
- **A console for each theme.** The terminal draws each palette as a console of its own, and Settings names the
  themes after them (`TERMINAL_THEME_LABELS`) while the style is on. The theme underneath is unchanged, so a
  change of style keeps the theme.

  | Theme | Console | Signal |
  |---|---|---|
  | Dark | Phosphor | green on black |
  | Dark purple | Ice | cyan over deep navy |
  | Dark brown | Amber | a monochrome amber CRT |
  | Light | Dossier | ink blue on white paper, a red stamp |
  | Beige | Manila | the same on a case folder |
  | Light brown | Archive | the same on browned paper |

  The canvas stays a neutral (Phosphor, Ice, Amber, Dossier) or a paper (Manila, Archive) field, as the classic
  tinted palettes do.
- **Opaque surfaces.** No translucency and no `backdrop-filter`: text contrast is the palette's own, checked like
  the classic palettes, and nothing on the scrolling surface costs more than in the classic style.
- **The look:**
  - type: monospaced everywhere in the chrome and the lists, a variable JetBrains Mono (OFL; latin, latin-ext and
    cyrillic subsets, 68 KB, loaded only while the style is shown), so weights are real, not synthesized;
  - panels: square, with a gap over a still grid (the deck), each framed by a 1 px line with corner brackets in
    the signal color, drawn by an `::after` over the panel so the layout never moves; the commander's active
    panel lights its frame;
  - the title strip: scanlines, the product's name stencilled in the signal color (a child window's file name is
    shown as it is), the place after it as a prompt (`>`) with a blinking block cursor; the mark as a wire frame
    of the cube (`assets/mark-wire.svg`, a mask in the signal color);
  - dialogs: a tinted header band, the title in the signal color behind a lit square, scanlines over the dimmed
    app; menus and popups opaque and framed;
  - stencilled section labels and column headers (capitals, tracking); never on names of files;
  - the cursor row of the active panel: a signal tint with a lit bar at its left edge; pressed toggles and the
    chosen option of a segmented choice in reverse video;
  - in the dark consoles the signal glows (a text shadow); paper does not.
- **Motion:** a menu or dialog scans in from the top in seven steps over 140 ms; the strip's cursor blinks once a
  second. Both stop under `prefers-reduced-motion`. Closing stays instant.
- **Main follows the style:** `window-state.json` keeps the style beside the theme, so the window, the app views
  and the editor window open in the console's chrome (`themeColorsOf(theme, style)`).
- **The text editor window follows it** (the session carries the style; `shared.appearance` changes apply live);
  the document's own fonts and the PDF's paper do not change. Liquid glass keeps showing it classic there, as
  before. The document window (`src/shared/docviewer`) keeps the classic look, as ADR-0041 decided.

## Consequences

- `tokens.test.ts` checks every console: text, muted, accent and danger at 4.5:1 on canvas, chrome and raised;
  success and warning at 3:1; the accent's foreground; the canvas the deepest field and neutral (but on tinted
  paper); text, muted and accent on the cursor row's tint; the signal as text on the strip and in a dialog's
  header; a field's border at 3:1; and no `backdrop-filter` or translucent surface in the style.
- Measured on the reference machine (144 Hz display, `stage-P06-2026-10-24-e2e-style-scroll.jsonl`, the spec
  `src/shared/e2e/specs/style-scroll.spec.ts`, `PANELYTH_STYLE_BENCH=1`): flat-10k scrolled at 300 px per frame
  for 2 s and then slowly for 1 s, the styles alternating.
  - The viewer's tile view: 433 frames in Terminal, 433–434 in Classic, a mean of 6.94 ms per frame in both, a p95
    of 7 ms, no frame over 20 ms and no long task (6 runs, twice).
  - The commander's Full view, 16 alternating runs: a median of 433 frames in Terminal and 433.5 in Classic, a
    mean of 6.96 against 6.94 ms per frame, no frame over 20 ms and no long task. A first run right after a build
    showed Terminal 2 % behind; turning each effect off in turn (the font, the frames, the halo) changed nothing,
    and the repeats did not reproduce it: noise on this machine.
- Bundle (`stage-P06-2026-10-24-petter-bundle.json` against `stage-C10.8-2026-10-24-petter-bundle.json`): CSS
  +15.4 KB per app (+3.1 KB gzip), JS +0.4 KB (the setting, the console names and their messages). The three font
  files ship with each app and load only when the style is on screen.
- The style is a layer over the marker classes: new UI that marks its regions and floating layers for the glass
  style gets the terminal's frames too.
- `specs/style.spec.ts`: choosing Terminal applies it to both apps, names the consoles, survives a restart (and
  main opens the window in the console's chrome), and the strip's buttons and drag areas still answer a real mouse
  (`WM_NCHITTEST`). `specs/commander/menus.spec.ts` checks the popup menus in all three styles.
- Open: the macOS and Linux runs.
