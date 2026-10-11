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
