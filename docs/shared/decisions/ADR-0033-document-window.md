# ADR-0033 — Document Window: PDFs and Text in a Window of Their Own

## Status

Accepted (2026-10-11), at the owner's request, outside the stage list (the active stage is P04). It adds a feature
and one dependency; it does not change another decision. Amends ADR-0027 (one new commander-only method) and
ADR-0032 (a third renderer in the package).

## Context

- In the commander, Enter on a PDF or a text file opened the system's app, and F3 opened the in-app lister (text
  and hex over the panels). The owner wants PDFs and text files to open inside the product, in a good viewer, in a
  separate window, and a setting to keep the system's default program.
- ADR-0027: a renderer gets only narrow, typed capabilities, entry ids instead of paths, and file bytes only through
  read-only `panelyth-media:` tokens. The commander already reads any file through such a token (`file.open`).
- `docs/shared/` rules: heavy libraries need an ADR; the renderer must stay responsive; large IPC payloads are avoided.

## Decision

- **A document window** is a second `BrowserWindow`, a child of the shell window (`parent`), created by main for each
  opened file. It can be moved, resized and closed on its own, and closes with the shell.
- **It has no bridge.** No preload, no IPC, sandboxed, `contextIsolation`. Its renderer is a third package,
  `src/shared/docviewer` (`@panelyth/docviewer`), served from its own origin `app://documents/` with its own CSP
  (`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `connect-src 'self' panelyth-media:`, no
  objects, no frames). Everything it knows is in the URL fragment main builds: the document kind, the file's name
  and size, the theme name, and one token URL. The path never reaches it.
- **One new method, `document.open { entryId, theme? }`**, in the commander's profile only (main method, ADR-0027).
  Main resolves the entry through the sidecar (`file.resolve`), decides the kind **again** from the resolved path
  (`documentKindOf`, `@panelyth/contracts`), mints a read-only token whose `fetchOrigin` is the documents origin
  (the commander's origin cannot use it) and opens the window. A file that is not a PDF or text is refused. The
  viewer's profile does not have the method.
- **Which files:** `.pdf`, and text by extension or conventional name (source, config, markup, logs, `README`,
  `Makefile`…; the list is in `documents.ts`). Everything else keeps today's behavior (the lister's hex view, the
  system app).
- **The setting** `commander.settings.documentOpen`: `window` (default) or `system` (Settings → Panels → "Open PDFs
  and text files with"). `window`: Enter, double-click and F3 open the window. `system`: Enter opens the system
  app and F3 the lister, as before. If the window cannot open, the commander says so and falls back to the system
  app (F3: the lister).
- **PDF viewer:** `pdfjs-dist` (the **legacy** build, which carries polyfills for newer JavaScript built-ins, so it
  works on whichever Chromium the shell's Electron has). Its worker, CMaps, standard fonts, ICC profiles and wasm
  decoders are files of the documents origin, copied by the package's build; nothing is fetched from a network.
  Pages are virtualized (`@tanstack/react-virtual`), each drawn at the device pixel ratio with a text layer for
  selection and search, and every pending render is cancelled when a page leaves the window or the zoom changes.
  The file is read with HTTP Range, so the first page shows before a large file has loaded. Features: thumbnails,
  page jump, fit width / fit page / zoom steps, rotation, document search with marks on the matches, a night mode
  that inverts the pages, password prompt. Scripts, XFA and `eval` are off.
- **Text viewer:** read-only, virtualized lines with a line-number gutter, find (Ctrl+F, Enter / Shift+Enter, F3),
  wrap toggle, text size, encoding detection (BOM, strict UTF-8, else Windows-1252) and line-ending display. It reads
  at most the first 16 MiB with one ranged fetch and says when a file was cut; a line longer than 20 000 characters
  is cut when drawn. Whole large files stay with the lister (F3 hex view) and the editor (F4).
- **No editing, no printing, no save.** The window cannot write anything.

## Amendment: the media window

Double-click, Enter and "Open" on an image or a video, in both apps, open the file in a **media window** instead of an
in-app overlay: a frameless, full-screen child of the shell window with no title bar or app chrome. Its page is the
shared media overlay (`MediaViewerOverlay`: zoom and fit, the Panelyth video player, previous / next, Esc to close),
served as `media.html` from the commander's origin, so it runs on the commander's profile (ADR-0027) like quick view and
needs no profile of its own. It is not the document window's page: that one has no bridge and could not host the
player.

- **Methods.** `media.openWindow { entryId, key, theme?, lang? }` (both profiles) opens it; main resolves the entry and
  refuses anything but an image or video. The listing stays with the window that opened it, which keeps `key` → index
  state: the media window calls `media.windowStep { direction }` (commander profile), main relays a `mediaWindow.step`
  event to the opener only, and the opener answers with `media.windowAnswer { requestId, item }` (both profiles; main
  accepts the answer only from the window the question went to, and gives up after 5 s). No folder list and no path
  crosses IPC, only one `ContentItem` per step.
- **Fallback.** The in-app overlay (the commander's `MediaViewerOverlay`, the viewer's image viewer and in-pane
  fullscreen player) stays for when the window cannot open.
- **Not in the window.** Selection and cursor do not follow the stepping back into the opener.

## Amendment: a file opened from the OS ("Open with", 2026-10-12, owner request)

When Panelyth is the app the OS opens a picture or a video with (chosen as the default app, "Open with", a file
dropped on the program, a file named on the command line), the file opens in a **media window of its own**, full
screen, and the app's main window is **not created**: no viewer, no commander, no folder restore. That is what
makes it fast: the picture is decoded and on screen about 0.3 s after the launch, some 20 to 40 ms after the point
where an ordinary start merely has its empty window ready (Windows, `adr-0033-…-e2e-openwith.jsonl`).

- **The path comes from the OS, and only main reads it.** Main takes the first argument that is an existing file
  (`fileArgument`; switches, the app's own script and names that are not there are skipped), also from a second
  launch while the app runs (`second-instance`) and from macOS's `open-file` event. It goes to the sidecar in one
  main-only method, `entry.fromPath { path }` → `{ dirId, entryId, kind, listed }`. No renderer method takes a path,
  and the window's URL carries none.
- **The sidecar** refuses anything but an image or a video, opens the file's folder as `dir.open` does (listed in
  the background in a scan lane of its own, watched) and puts the file itself in the index at once, so the picture
  never waits for a folder of 100,000 files. It waits at most 150 ms for the listing, which is enough for a folder
  of a few thousand files; `listed` says whether the listing was complete.
- **A window without an opener.** Such a media window has no parent (the shell may not exist, or be minimized) and
  its fragment says `alone=1`. Its page asks for items exactly as before (`media.windowStep`); main answers from a
  session it holds for that window (`OpenWithSession`): the folder's pictures and videos by name, as the viewer
  lists them by default, following the listing as it arrives. While a large folder is still being listed, a step
  that finds no neighbour asks once more after 0.3 s. The session closes with the window.
- **Into the app.** In such a window a double-click on the picture or video, or the button "Open in Panelyth", does
  not close it: `media.windowReveal {}` (commander profile, no parameters; main accepts it only from a window it
  opened for a file) shows the **viewer** on the file's folder with the file selected, then closes the media window.
  When no main window exists, main creates it showing the viewer, whichever app was used last, and the viewer asks
  once at start what it was started for (`app.openRequest {}` → `{ request: { dirId, entryId } | null }`, viewer
  profile); the configured startup folder is not opened then. When the viewer runs already, main sends it the
  `open.request { dirId, entryId }` event. Esc and Close end the window; when it was the only one, the app ends.
- **Not a picture or a video:** the app starts as usual. A second launch without a file brings the main window to
  the front, or opens it when only media windows exist.
- **Not in such a window:** Edit (there is no editor behind it; take the picture into the viewer first).
- **Not decided here: file associations in the packages.** The feature works when the user picks the program
  ("Open with → choose an app", a command line). Declaring the picture and video types in the installers (NSIS,
  the macOS bundle's document types, the Linux desktop entry's MIME types), so the app is offered by the OS, changes
  what an installation does to the user's system and is the owner's call (Stage P06).

Verified: unit tests for the argument, the session (the file first, neighbours, a hidden file, a listing under
way, close), the standalone window, the per-app allowlist and validation, the page and the overlay, the viewer's
start and the event; a Go test for `entry.fromPath`; E2E `openwith.spec.ts` (a cold start with a file: one window,
no main window, next and previous, double-click into the viewer with the file selected; the app already running;
a file that is no picture). Not run: the packaged app, macOS (`open-file`) and Linux.

## Consequences

- One more renderer to build and ship (`documents/` in the package, `pnpm build`, the dev server on port 5175).
- `pdfjs-dist` (about 1.3 MB of worker plus data files, loaded only when a PDF opens; a text file never loads it).
- The media protocol exposes `Accept-Ranges` to CORS requests, which lets pdf.js use range requests.
- Viewer Mode, archives, and other panels' file kinds are unchanged. A future viewer-app use of the window would need
  its own profile decision.

## Verification

- Unit tests: kind detection, the URL fragment, the CSP, the router's per-app allowlist and validation, the text
  decoder, find, the viewer components and the commander's routing (Enter, F3, the setting, the fallback).
- The window's renderer was run in Chromium against a PDF and a text file (rendering, thumbnails, search, jump).
- Not yet run: the packaged Electron app on all three operating systems.
