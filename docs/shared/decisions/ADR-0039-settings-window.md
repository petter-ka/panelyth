# ADR-0039 — Settings in a Native Window

## Status

Accepted (2026-10-14), at the owner's request, outside the stage list, like ADR-0033. It changes where Settings is
shown; it adds no capability. Amends ADR-0027 (two new main methods in both profiles) and ADR-0031 (a setting
written by the settings window reaches its app view).

Amended by ADR-0048 (2026-10-31): the commander's settings (`commander.settings`) written by its settings window
also reach its open compare windows.

## Context

- Settings was an in-page dialog of each app view (`SharedSettingsDialog`, `src/shared/ui`): the General,
  Appearance, Shortcuts and About tabs shared by both apps, and the app's own tab (the viewer's or the
  commander's).
- The owner wants Settings as a native child window that **blocks the main window while it is open but can be
  moved**, like the settings windows of desktop apps.
- ADR-0027: a renderer gets only its app's narrow, typed capabilities; main checks each call against the profile of
  the origin it came from. ADR-0033 already puts a second page on an app's origin (the media window, `media.html`
  on the commander's origin), so it runs on that app's profile without a profile of its own.
- ADR-0031: `shared.*` settings reach the other app through the `settings.changed` event. An app's own keys were
  written and read by that app's view alone.

## Decision

- **A settings window** is a `BrowserWindow` with the OS title bar ("Settings"), a child of the shell window
  (`parent`), 640 × 640 px (resizable, at least 520 × 480), not minimizable, not full-screenable. There is one at a
  time; asking again focuses it.
- **It blocks the shell window.** On Windows and Linux it is `modal`. On macOS a modal window is a sheet fixed to
  the parent's title bar, which cannot be moved, and disabling the parent is no better: Electron does it by covering
  the window with a half-transparent sheet, which looks frozen (amended 2026-10-15 after the first macOS build). So on
  macOS it is an ordinary child window that takes the focus back whenever the shell window gets it; a click on an
  inactive macOS window only activates it, so neither app takes input meanwhile.
- **Its page is `settings.html` on the opening app's origin, with that app's preload**, so it runs on that app's
  profile (ADR-0027) and shares its origin's storage: the stored theme, interface size and language apply before
  the first paint, as in the app. Main takes the origin and preload from the calling web contents, never from a
  parameter. Nothing is added to either profile but the methods below.
- **Two methods** (main, both profiles). `settings.openWindow { tab? }`: `tab` is one of `general`, `viewer`,
  `commander`, `programs` (ADR-0044), `appearance`, `shortcuts`, `about`; the page shows it first, and a tab of the other app is refused.
  `settings.closeWindow { then? }`: only the settings window may call it; it closes, and `then: "shortcuts"` hands
  the keyboard shortcuts to its app view.
- **The page** is the dialog's content laid out as a window: the same tabs, the same components, the same stores.
  It starts what those need (the sidecar status, `library.get` for the stored settings, the About sync) and
  nothing else of the app: no listing, no panels, no thumbnails.
- **Changes apply at once.** The page saves with `library.setSetting`, as the dialog did. A key the settings
  window writes is relayed by main as `settings.changed` to the window's app view (`shared.*` keys still go to
  every web contents). Other writers' keys are not relayed: the commander's panels and the viewer's workspace are
  written often and concern no other view. The app views apply what arrives:
  - viewer: the library store takes the value, so the viewer and editor settings reload as after a library load;
  - commander: `commander.settings` (and a changed "Show hidden and system files" reaches every panel and tab),
    `commander.tools` (commands and toolbar) and `commander.layout` (the folder tree mode).
- **Keyboard shortcuts** stay a dialog of the app view (it edits the app's live keymap): the Shortcuts tab's
  button closes the window and main tells its app view to open the dialog (the `menu.command` event).
- **The native menu's Settings… and About Panelyth** open the window (About on the About tab).
- **Fallback:** when the window cannot open (no bridge, as in component tests, or an error), the in-page dialog
  is shown as before.

## Consequences

- Settings looks and moves like a desktop settings window; the app behind it cannot change while it is open, so
  the window never edits a stale copy of the app's state.
- Each app ships a second small page (the commander a third, beside `media.html`). The page loads only the
  settings code and its stores.
- End-to-end specs reach Settings by polling the app's windows for `settings.html` (Playwright reports a new
  window once, possibly before its page has loaded) instead of the app page
  (`openSettingsWindow`, `settingsWindow` in `src/shared/e2e/launch.ts`). Esc closes the window on keydown, so a
  spec sends the keydown alone.
- The commander specs count entries of folders with hidden files; since hidden entries are shown by default, their
  helper turns them off once per run in the settings window, as a user would.
- A future setting whose effect lives in the app view needs its key relayed and applied in that view; the list
  above is the place to add it.
