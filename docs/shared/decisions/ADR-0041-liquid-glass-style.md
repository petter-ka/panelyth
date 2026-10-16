# ADR-0041 — Liquid Glass Style

## Status

Accepted (2026-10-16), at the owner's request, outside the stage list, like ADR-0033, ADR-0039 and ADR-0040.
Amends ADR-0014: its rule against `backdrop-filter`, shadows and gradients in the chrome holds for the classic
style; the glass style below is the measured exception.

## Context

- The owner asked for a new design for both apps in the style of Apple's liquid glass (translucent, floating
  surfaces with lit edges), with the current design kept and selectable in Settings.
- ADR-0014 rules out `backdrop-filter`, shadows and gradients in the chrome, and any effect on the scrolling
  surface without a measured trace. The tile view and the commander's lists are the hot paths
  (`docs/shared/PERFORMANCE.md`).
- The viewer's neutral surround (ISO 3664) exists so the chrome does not tint how a photo is judged.
- Components use token classes (`bg-chrome`, `bg-canvas`, `bg-raised`, `border-border`), never raw colors, in
  about 200 places in both apps.

## Decision

- **A design style, apart from the palette.** `shared.appearance.style` is `"glass"` or `"classic"`, shared by
  both apps like the theme, mirrored in `localStorage` (`panelyth.style`) and applied as `data-style` on `<html>`
  before the first render. Every palette (Dark, Light and the four tinted ones) works in both styles. Settings →
  Appearance → Style offers Classic and Liquid glass. Classic, the previous design unchanged, is the default: a
  fresh profile and a profile saved before the style existed open in it, and Liquid glass is one click away.
- **Glass by token scope, not by component.** The glass style is CSS in `src/shared/ui/src/styles.css` under
  `:root[data-style="glass"]`. A few marker classes name the roles:
  - `.glass-shell`, `.glass-stack`: app roots and stacks get a gap of 8 px, so the regions float.
  - `.glass-region`: a card (app rail, viewer sidebar, content and preview, commander toolbar, panels, trees,
    quick view, bottom dock). It is rounded and translucent, and inside it `--chrome` is clear and `--canvas` and
    `--raised` let the card through, so the components keep their token classes. Sticky headers inside a card
    take an opaque stand-in, so rows do not show through them.
  - `.glass-float` (menus, popups) and `.glass-sheet` (dialogs): blurred floating layers.
  - `.glass-chip`: a layer that stays over the scrolling surface (the viewer's batch bar and jobs panel, the
    notice, quick search). It is glass without the blur, and denser.
  - `.glass-pill` (buttons, segmented controls, tabs), `.glass-gutter` (resize handles: the gap is the handle).
  - New `chrome-solid` and `canvas-solid` colors stay opaque on glass, for veils over pictures and states that
    cover a list.
- **The wallpaper** behind the cards is three soft radial blooms of the palette's own accent, blue and purple
  over its canvas. It is painted once and never moves.
- **No blur on cards.** A card sits over the still wallpaper, which is already soft, so a `backdrop-filter`
  there would cost GPU work on every repaint and change nothing visible. Only menus, popups and dialogs blur,
  and they are transient. Nothing on the scrolling surface blurs. In dark palettes the blur also dims what is
  behind (`brightness(0.5)`), so muted text keeps AA over a bright picture.
- **The lit edge** of a card or layer is a 1 px gradient ring drawn by an `::after` with a mask, so it never
  changes the layout.
- **Full-window media overlays keep the solid canvas** (the image viewer, the editor, the media window and the
  lister): pictures are judged on it in both styles. The tile view and the preview sit on a translucent canvas
  over a card; the share is chosen so the wallpaper contributes about a fifth.
- **Motion** in the glass style: menus and dialogs pop from 96 % over 200 ms with a slight overshoot. Closing
  stays instant, and everything is off under `prefers-reduced-motion`.

## Consequences

- `tokens.test.ts` composites every palette's cards (and the content, controls and sticky headers on them) over
  the wallpaper's strongest colors, and menus, dialogs and chips over a black and a white picture. Text, muted,
  accent and danger must reach 4.5:1 on each. The shares in the CSS were tuned to that bound. The test also
  checks that no card, chip or settings page has a `backdrop-filter`.
- Measured on the reference machine (144 Hz display, `stage-P06-2026-10-16-petter-glass-scroll.jsonl`): the
  viewer's tile view and the commander's Full view on `flat-10k`, scrolled at 300 px per frame for 2 s and then
  slowly for 1 s, three alternating runs per style. Both styles gave 434 frames, a mean of 6.94 ms per frame, a
  p95 of 7 ms, no frame over 20 ms and no long task.
- Bundle (`stage-P06-2026-10-16-petter-bundle.json` against `-bundle-2`, the baseline): CSS +9.0 KB per app
  (+1.3 KB gzip), JS +1.2 to +1.4 KB (the setting and its messages).
- On Windows, text on a translucent scroller is drawn with grayscale rather than LCD anti-aliasing.
- New UI marks its regions and floating layers with the classes above. A component that draws over a picture
  uses `chrome-solid` or `canvas-solid`.
- The document window (`src/shared/docviewer`) keeps the classic look; it has its own build and does not read the
  style.
- Open: native window materials (Mica or acrylic on Windows 11, vibrancy on macOS) behind a transparent page
  would let the desktop show through. That needs transparent `WebContentsView`s and main to follow the style,
  and is a separate decision.
