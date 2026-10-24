# ADR-0046 — Text and Markdown Editor

## Status

Accepted with amendments in Stage C10.6 (2026-10-24; proposed 2026-10-23 at the owner's request). Amends ADR-0027
(a new `texteditor` profile, outside the apps' list), ADR-0033 (the document window stays read-only; editing has a window of its own), ADR-0037 (a
remote file can be edited and uploaded back) and ADR-0044 (F4 can mean the built-in editor). Brings a built-in text
editor into the commander's first release (`docs/commander/BRS.md` CFR-32; it was out of scope).

Amendments found in Stage C10.6:

- **Names.** `editor` and the `edit.*` methods were the image editor's (ADR-0035, `internal/editor`, main's
  `editor.ts`): the text editor's origin is `app://texteditor`, its profile and main methods `texteditor.*`, the
  sidecar's methods `textedit.*` (package `internal/textedit`) and main's window manager `textEditorWindow.ts`.
- **The profile is not an app.** `AppId` and its records stay the shell's three apps; the router matches the editor
  window's origin before the apps and answers its six methods from their own handlers. An app cannot call them,
  and the editor window cannot call anything else (no file ids, no settings, no sidecar method).
- **Compare** on a conflict is left for later: the C08 diff compares files, and the unsaved text is none. A
  conflict offers Overwrite, Reload and Cancel.
- **F3 and F4 on Markdown** (owner request 2026-10-24): F3 and Enter show a Markdown file in the editor window in
  Preview, read-only; its Edit button, or F4 (in the window or on the file in the commander), turns editing on in
  the same window, in Live. F4 opens it in Live to edit. The remembered mode is dropped. A Markdown file the editor
  can't take (in an archive, too large) still opens in the document window. Other text files: F3 as before.
- **Pictures are copied, never linked where they lie** (C10.7): linking a dropped file where it is would have the
  page hand main a path. Identical bytes already in the folder are linked instead of copied again.
- **Quitting asks first** (C10.7): a window with unsaved text asks (Save, Don't save, Cancel) before main stops the
  sidecar, and the quit stops while it asks; quitting again goes on once no window is dirty. Before, the sidecar was
  stopped first and a Save could not be written.
- **F4 on Linux and macOS** opens the built-in editor too when Settings names no editor (it opened `open -t` or the
  OS default app before); a script is shown as text and never run.

## Context

- The owner wants a Markdown and text editor beside the files: Markdown that looks like the finished page while
  typing, code and config files with syntax colors, images dropped or pasted into the text, find and replace, a word
  count, a PDF export, and files on servers saved back to them.
- The document window (ADR-0033) is read-only by design: no preload, no bridge, one read-only token per file
  (`src/shared/desktop/src/main/documentWindow.ts`). Adding a bridge to it would weaken that guarantee for every
  untrusted PDF it opens.
- The viewer may not open non-media files (ADR-0027). The commander opens text with F3 (lister) and F4 (an external
  editor, ADR-0027, started without a shell).
- No sidecar method writes a file's contents today. Remote files are FTP and FTPS (ADR-0037), downloaded to the
  cache for viewing and never edited; uploads write the final name directly.

## Decision

- **Commander only, in a window of its own:** an editor window with its own origin (`app://texteditor/`), preload and a
  narrow `editor` capability profile. One window per file; opening a file that is already open focuses its window.
  Code: `src/shared/doceditor` (the renderer; reuses the docviewer's decoding), main's `textEditorWindow.ts`, and the
  sidecar's `textedit` service.
- **Sessions, not paths:** main mints an editor session at open (from an entry id the commander sent) and binds it
  to that window. Every editor method takes the session id only; the page never names an entry id or a path.
- **Opening:** the sidecar reports size, modified time, encoding, line endings and a SHA-256 of the bytes as the
  version. The page reads the bytes through a read-only token, as the document window does, so file bytes never
  travel over IPC. Up to 8 MiB is editable; a larger file opens read-only in the lister.
- **Engine: CodeMirror 6.** It draws only the visible lines (invariant 5), its document stays outside React state,
  and it handles prose and code alike. Languages load on first use (`@codemirror/language-data`, legacy modes for
  YAML, TOML, INI and shell). The live Markdown view is our decorations over the `@lezer/markdown` tree: syntax marks
  hide away from the cursor's line. Rejected: Monaco (3–5 MB, workers, no live view); ProseMirror, TipTap and
  Milkdown (they rewrite the Markdown and do not edit code).
- **Saving (local):** the page sends the text in chunks of at most 256 KiB, then a commit with the version it
  started from. The sidecar encodes it back to the file's encoding and line endings, writes a temporary file in the
  same folder, syncs it and renames it over the original (a link is written through, never replaced). A changed
  version on disk is a conflict: Overwrite, Reload or Compare (the C08 diff). The check runs again when the window
  regains focus.
- **Saving (FTP/FTPS):** the save writes the cached copy and starts one upload job; the upload goes to a temporary
  name on the server and is renamed over the file, so a broken upload never truncates it. The conflict check compares
  the server's modified time and size from a fresh listing of that entry. The editor holds its connection open.
  SFTP stays out of scope.
- **Images:** a pasted or dropped picture is sent in chunks; the sidecar checks it is a picture, caps its size and
  writes it under a unique name into `assets/` beside the document (the folder name is a setting), and the editor
  inserts a relative link. Images the document links to are resolved in one batched call, kept inside the document's
  folder tree, and shown through read-only tokens. Images on the web are not loaded; raw HTML is shown as text.
- **Three modes for Markdown** (owner request 2026-10-23), a switch in the editor's header: **Source** (the
  text editor with syntax colors), **Live** (the preview editor: the page as it will look, editable, the syntax
  marks shown only on the cursor's line) and **Preview** (the rendered page, read-only). Ctrl+E steps through them;
  the cursor's line and the scroll position carry over (mapped through the source lines); the last mode used is
  remembered per file type (`commander.editor`), Live for Markdown at first. Other files have Source only and no
  switch. Preview is HTML rendered from the same lezer tree as the live view and cleaned by DOMPurify, the same
  rendering the PDF export prints.
- **PDF export:** `webContents.printToPDF` of the editor's own page with a print stylesheet over the rendered
  document (HTML from the same lezer tree, cleaned by DOMPurify). Main writes the PDF to the path chosen in its save
  dialog, asynchronously and atomically, a narrow exception like main's other dialog-owned writes.
- **F4:** opens the built-in editor unless an external editor is set in Settings (then that one starts, as before);
  Shift+F4 creates a file and opens it in the same editor. The entry menu has "Edit" for both.

## Consequences

- New dependencies (CodeMirror 6 packages, `@lezer/markdown`, DOMPurify): about 80–90 KB gzipped in the editor's
  bundle only; the viewer's and the commander's bundles do not change (`pnpm bench:bundle`).
- New budgets in `docs/commander/PERFORMANCE.md`: keystroke to paint ≤ 16 ms at p95 on 1 MB of Markdown, opening
  1 MB ≤ 300 ms, a local save ≤ 150 ms.
- Stages: C10.6 (the editor, save, find and replace, word count, F4), C10.7 (the three Markdown modes: Source, Live and Preview, and images),
  C10.8 (PDF export), C10.9 (saving to FTP/FTPS). All before C11 and P05, so P05 profiles the editor.
