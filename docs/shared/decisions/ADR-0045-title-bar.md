# ADR-0045 — The Window's Title Strip (Windows)

## Status

Accepted (2026-10-23), at the owner's request, outside the stage list, like ADR-0044. Amended the same day (owner
request): the window buttons are the strip's own, drawn with the app's icons, instead of Windows' buttons laid
over the page; and view switchers beside them. Amends ADR-0027 (two main methods in all three app profiles),
ADR-0031 (the shell's main window) and ADR-0038 (the native menu has no bar row on Windows and Linux; see its
amendment of the same day).

## Context

- The owner asked for the window's top row (the title, minimize, maximize and close) to be redesigned. Windows
  drew it in the system's colors, unrelated to the app's theme, with "Panelyth" alone in it; then for the three
  buttons to have other icons.
- The main window shows three apps: the viewer is the window's own page, and the commander and Panelyth System are
  `WebContentsView`s laid over it (ADR-0031). Whatever replaces the row must work in all three, in every theme
  and in both styles (ADR-0041).
- Electron's `titleBarOverlay` keeps Windows' own buttons and only recolors them; their icons cannot change. The
  first version used it. Buttons of our own lose what Windows gives its own: the Snap Layouts menu on hovering
  maximize (Win+Z and dragging to a screen edge still snap) and the frame's own accessibility.

## Decision

- **Windows only:** the main window is created with `titleBarStyle: "hidden"` and no overlay: no native title row
  and no native buttons (`src/shared/desktop/src/main/window.ts`). macOS and Linux keep their own title bar.
- **The page draws the strip and its buttons.** `TitleBar` (`src/shared/ui/src/TitleBar.tsx`) sits in each app's
  shell grid right of the rail, 33px with its border: the app's product name and where it is (the viewer's open
  folder; the commander's active panel, written as its path bar writes it), and minimize, maximize/restore and
  close as thin rounded line icons in soft rounded squares; close turns red on hover. The strip is the window's
  drag handle (`app-region: drag`; a double-click maximizes); the buttons are not.
- **The mark in the corner.** The Panelyth mark (the small drawing of `scripts/icons.mjs`, written to
  `src/shared/ui/src/assets/mark.svg`) takes the corner above the rail, as tall as the strip, its line continuing
  the strip's: the title row runs the window's width and the rail starts below it (owner request).
- **View switchers** sit left of the window buttons, behind a thin rule (`TitleBarControls.tsx`), and never take the
  focus from the panels or the tiles. The viewer: the tile size (small, medium, large) and the preview's place
  (under the folders, or a column on the right). The commander: layout presets that set the whole window at
  once (`src/commander/renderer/src/features/layoutPresets.ts`), never only the active panel (owner request; a
  switch of the active panel's view proved confusing): Details (both panels Full), List (both Brief), Tree (a
  folder tree beside them), Gallery (both Thumbnails), Single (the active panel alone across the window as thumbnails,
  Tab showing the other; quick view brings both back while open; owner request 2026-10-24), Preview (quick view in
  the other panel) and Stacked (the left panel above the right one). Stacked and Single are arrangements kept in
  `commander.layout`. The presets are one button, "Layout presets" (owner request 2026-10-27,
  `TitleBarGridMenu`), showing the drawing of the preset the window matches; pointing at it (or a click, Enter or
  the down arrow) opens every preset as a large tile with its name and what it does, four to a row. Opened by
  pointing, the menu closes once the pointer has left both the button and the menu. A preset is lit only while the
  window matches it; after a change by hand none is. Closing the menu gives the keys back to the panel that had
  them, or to the active panel's list when the preset rebuilt the panels.
  While the strip is on screen, the viewer's sidebar has no title row ("Panelyth" and the preview switch) and its
  view bar no tile size control (owner request); without the strip (macOS, Linux, full screen) they are back. The
  tile menu's "Tile size", Ctrl + wheel and the keys stay. Panelyth System has no switchers.
- **Main moves the window.** Two main methods in the viewer's, the commander's and System's profiles:
  `window.getState` (`{ maximized, fullScreen }`) and `window.control` (`minimize`, `toggleMaximize`, `close`).
  Main acts only when the caller is one of the main window's app views; the settings window, which shares the
  viewer's origin, is refused. Main sends `window.state` to the app views on maximize, restore and full screen.
- **Which views draw it:** main passes `TITLE_BAR_ARG` to the main window's page and the app views on Windows;
  preload exposes it as `frame.titleBar`. The strip has no height without it and in full screen.
- `data-title-bar` on `<html>` sets `--title-bar-height`. The full-window overlays (the image viewer, the editor,
  the lister, the media viewer: `.below-title-bar`) and the loading curtain start below the strip.
- **Colors from the start.** Main keeps the stored theme in `window-state.json` (beside the window's size), so the
  window and its views open in the last run's chrome before the sidecar answers; it follows `shared.appearance`
  and, for "system", `nativeTheme` changes.

## Consequences

- The strip (33px) takes the place of the native frame's title row, about as tall.
- No Snap Layouts menu on the maximize button.
- A drag region stays draggable under a dialog's scrim (Electron); nothing covers the strip's buttons.
- Windows hit-tests the drag areas of every page in the window, the hidden ones too, and the viewer's page lies under
  the other apps' views: its strip's drag area took clicks meant for the commander's switchers. An app that is not
  on screen gives up its strip's drag area (`data-inert`; `window.getState` says whether the caller is shown, then
  `app.visibility` keeps it current). `src/shared/e2e/hitTest.ts` asks the window itself (`WM_NCHITTEST`) what a
  real mouse would do over each button, in every app; Playwright's clicks skip that test.
- **Child windows** (owner request 2026-10-24): the settings window, the document window and the text editor window
  draw the strip too, with the mark at its left and only the buttons the window has (the modal settings window:
  Close). The window calls act on the caller's own window only (`frameWindowOf`); the document window, which had
  no preload, gets a frame-only one (`frame.cjs`) on Windows, and its origin may make the two window calls and
  nothing else. Windows without a title row (the full-screen media window) stay as they are.
- On macOS and Linux the strip is not drawn, so its switchers are not there; the controls they repeat are. The
  commander's layout presets have no other control, so without the strip (macOS, Linux, full screen) the same
  button sits in the toolbar right after the edit button (owner request 2026-10-29).
- E2E specs pick the tile size through `tileSizeSwitch` (`src/shared/e2e/launch.ts`): the strip's on Windows.
- `src/shared/e2e/specs/switch.spec.ts` checks the strip's place and height and that its buttons maximize, restore
  and minimize the window; `src/shared/ui/src/titleBar.test.tsx` the labels, the full-screen state and the order
  of state answers.
