# Development Stages

Only one stage is active at a time, across all tracks. The order across tracks is in `docs/ROADMAP.md`.

## Tracks and stage IDs

| Track | Stage IDs | Stage documents | Bench result IDs |
|---|---|---|---|
| Viewer | `00`…`08.6` (history), `12`…`16` (image editor); next new stage `17` | `docs/viewer/stages/` | `stage-03-…`, `stage-08.6-…`, `stage-12-…`, `stage-13-…`, `stage-14-…`, `stage-15-…`, `stage-16-…` |
| Platform | `P01`…`P06` | `docs/shared/stages/` | `stage-P01-…`, `stage-P06-…` |
| Commander | `C00`…`C11`, with `C10.5` between C10 and C11 | `docs/commander/stages/` | `stage-C00-…`, `stage-C10.5-…` |

- The viewer stages 00–08.6 also built most of the shared platform; their records stay in the viewer track.
- The viewer's planned Stages 09, 10 and 11 became P04, P05 and P06 (2026-10-05, ADR-0025). Viewer numbers 09–11 are
  retired.
- Viewer Stages 12–16 (2026-10-11, owner request) are the image editor (`docs/viewer/IMAGE-EDITOR.md`; ADR-0035,
  accepted in Stage 12, and ADR-0036, accepted with amendments in Stage 16). The owner scheduled them on 2026-10-12,
  in order, after C10.
- Commander Stage C10.5 (2026-10-12, owner request) adds tab sets, a folder tree, FTP connections (ADR-0037,
  accepted with amendments in the stage) and comparing several selected files. It sits before the release stage, as
  08.5 and 08.6 sat before the viewer's hardening stages. The owner started it the day it was planned, after 16.
- New stage documents start from `docs/STAGE-TEMPLATE.md`.

## Stage gates

A stage is complete only when:

- implementation exists
- automated tests exist
- failure paths are covered
- relevant benchmark passes
- docs/ADR updated
- no known performance regression violates the current budget, in either app once the commander exists

## Sequence

### Viewer

| Stage | Name | Depends on | Status |
|---|---|---|---|
| 00 | Foundation | — | done |
| 01 | File index | 00 | done |
| 02 | Thumbnail + poster pipeline and cache | 01 | done |
| 03 | Virtualized tile view | 02 | done |
| 04 | Image viewer | 03 | done |
| 05 | Filesystem UX + navigation + search + sort | 04 | done |
| 06 | Video playback + media preview | 05 | done |
| 07 | Batch operations + metadata foundations | 06 | done |
| 08 | Product polish + extensibility foundations | 07 | implementation done; tests pending |
| 08.5 | Viewer settings + interaction polish | 08 | implementation done; tests pending |
| 08.6 | UI polish v2 (folder covers, …) | 08.5 | done (2026-10-05) |
| 12 | Image editor foundation: Edit button, session, geometry, save, info panels | 08.6, P03 | implementation done (2026-10-12); the NVDA pass and the Linux and macOS runs remain |
| 13 | Image editor: color tools | 12 | implementation done (2026-10-12); the full-resolution region view, the NVDA pass and the Linux and macOS runs remain |
| 14 | Image editor: effects | 13 | implementation done (2026-10-12); the NVDA pass, an arm64 run of the golden hashes and the Linux and macOS runs remain |
| 15 | Image editor: draw and retouch | 12 | implementation done (2026-10-12); red-eye Auto is interactive-only; the NVDA pass and the Linux and macOS runs remain |
| 16 | Image editor: batch mode | 12, 13, 14 (15 for auto red-eye) | planned |

### Platform

| Stage | Name | Depends on | Status |
|---|---|---|---|
| P01 | Multi-app platform: one shell, app views, shared packages | 08.6 | implementation done (2026-10-12); the owner's word on bundles that grew by under 0.1 %, the hidden viewer on a window resize and the Linux and macOS runs remain |
| P02 | Index scope: all entries, filtered per query | P01 | implementation done (2026-10-12); ADR-0026 accepted with amendments; the owner's word on a 12–17 % slower cold scan of `flat-100k`, a benchmark run with links and the Linux and macOS runs remain |
| P03 | File-operation engine v2 | P02 | implementation done (2026-10-06); Linux/macOS paths in P04 |
| P04 | Cross-platform hardening (formerly 09) | P03 and the app stages in scope | in progress: packaging, CI, release builds and the Linux pass done (2026-10-08); paths, volumes, media tools, wheel input and the viewer's e2e specs done on Windows and Linux (2026-10-12); the macOS items, budgets on Linux and macOS and four stale commander e2e tests remain |
| P05 | Performance hardening (formerly 10) | P04 | planned |
| P06 | Release engineering (formerly 11) | P05 | implementation done on Windows (2026-10-12, taken before P05 at the owner's request); ADR-0038 accepted; an update feed installed apps can read, the signing certificates, a small ffmpeg build and the macOS and Linux runs remain |

### Commander

| Stage | Name | Depends on | Status |
|---|---|---|---|
| C00 | Foundation and the app switch | P01 | done (2026-10-05) |
| C01 | Panels and listing | C00, P02 | implementation done; cold-cache 100k timings open (P02 was completed on 2026-10-12) |
| C02 | Keyboard, marks and quick search | C01 | implementation done; the NVDA pass and the C01 open items remain |
| C03 | Drives, tabs, hotlist, history and session | C02 | implementation done (2026-10-06); the NVDA pass remains |
| C04 | File operations | C03, P03 | implementation done (2026-10-06); the NVDA pass remains |
| C05 | Quick view, lister, open and edit | C04 | implementation done (media routing added 2026-10-09); the NVDA pass remains |
| C06 | Find files, branch view and quick filter | C05 | implementation done (2026-10-07); the NVDA pass remains |
| C07 | Archives | C06 | implementation done (2026-10-07); the NVDA pass and a run with a real 7-Zip remain |
| C08 | Compare, synchronize and checksums | C07 | implementation done (2026-10-11); the NVDA pass and a FAT/network run of a sync remain |
| C09 | Multi-rename, attributes and properties | C08 | implementation done (2026-10-11); the NVDA pass and the Linux and macOS runs remain |
| C10 | Command line, tools and customization | C09 | implementation done (2026-10-11); the NVDA pass and the Linux and macOS runs remain (the viewer's e2e tile suite ran green on 2026-10-12, Stage P01) |
| C10.5 | Tab sets, folder tree, FTP connections, compare selected files | C10 | implementation done (2026-10-12); ADR-0037 accepted with amendments; the owner's confirmation of FTP in the first release, the Linux and macOS runs and the NVDA pass remain |
| C11 | Commander release | C10, C10.5, P04, P05, P06 | planned |

## Completed stages

| Stage | Completed | Record |
|---|---|---|
| 00 — Foundation | 2026-09-30 | `docs/viewer/stages/00-foundation.md` |
| 01 — File index | 2026-09-30 | `docs/viewer/stages/01-file-index.md`, `src/shared/bench/results/stage-01-*` |
| 02 — Thumbnail pipeline + cache | 2026-09-30 | `docs/viewer/stages/02-thumbnail-pipeline.md`, `src/shared/bench/results/stage-02-*` |
| 03 — Virtualized tile view | 2026-09-30 | `docs/viewer/stages/03-tile-view.md`, `src/shared/bench/results/stage-03-*` |
| 04 — Image viewer | 2026-09-30 | `docs/viewer/stages/04-viewer.md`, `src/shared/bench/results/stage-04-*` |
| 05 — Filesystem UX + navigation + search + sort | 2026-09-30 | `docs/viewer/stages/05-filesystem-ux.md`, `src/shared/bench/results/stage-05-*` |
| 06 — Video playback + media preview | 2026-10-01 | `docs/viewer/stages/06-media-playback.md`, `src/shared/bench/results/stage-06-*` |
| 07 — Batch operations + metadata foundations | 2026-10-01 | `docs/viewer/stages/07-batch-and-metadata.md`, `src/shared/bench/results/stage-07-*` |
| 08.6 — UI polish v2 | 2026-10-05 | `docs/viewer/stages/08.6-ui-polish-v2.md`, `src/shared/bench/results/stage-08.6-*` |
| C00 — Commander foundation and the app switch | 2026-10-05 | `docs/commander/stages/C00-foundation.md`, `src/shared/bench/results/stage-C00-*` |

## Active stage

`P06 — Release engineering` (`docs/shared/stages/P06-release.md`), started 2026-10-12 at the owner's request while
P04's macOS items and P05 stay open; implementation done on Windows the same day. ADR-0038 is accepted. The owner
added two things to the stage: the app is upgraded from inside the app, and a native menu. **Updates:** Electron
main looks for a newer version 15 s after start and every six hours, downloads it only when asked and installs it
on restart; Settings → About (a tab of the shared settings dialog, both apps) shows the version, the state, the
newer version's notes as plain text and the next step. A build that cannot install (an unsigned macOS app, a Linux
tar.gz) offers the download page. **The native menu** replaces Electron's default one: File, Edit, View and Help,
in the eight languages, with About, Check for Updates…, the log folder, the licences and the project's pages.
**One version** for the shell and the sidecar (`PANELYTH_VERSION`; the sidecar reports `1.2.3+g<commit>`).
**The pipeline:** `pnpm package` builds, fetches a pinned LGPL ffmpeg beside the sidecar (Windows and Linux),
writes one generated licence notice file and signs and notarizes when the certificates are configured; a pushed tag
builds all three OSes into a draft release with the update metadata. **Data across versions:** `library.db` opens
from every schema with its rows, released migrations are pinned, and `index.db` is recreated from a newer schema as
from an older one. Tested on Windows end to end: version 0.9.0 installed, found 0.9.1 in About, downloaded it,
restarted into it and was uninstalled (2.1 minutes). Measured: startup and idle memory as before (ready-to-show
253 ms, 149 MB over the Electron floor); the installer grows from 137 to 190 MB with ffmpeg.

Open from P06: an update feed installed apps can read (the GitHub repository is not public); the signing
certificates (nothing of the signed or notarized path has run); the first version number; a small ffmpeg build of
our own (the pinned one is a full LGPL 3 build and is absent on macOS); the macOS and Linux runs of the package, the
menu and an update; the release workflow's first run. `docs/RELEASING.md` and `docs/INSTALL.md` are new.

Before that (still in progress):
`P04 — Cross-platform hardening` (`docs/shared/stages/P04-cross-platform.md`), started 2026-10-08 and taken up
again on 2026-10-12 at the owner's request, after P02; still in progress. This slice did the items that were not
started, on the reference machine and (the Go suite) on Linux as root and as an ordinary user. **Paths:** a
`path_key` folds what the platform's filesystems fold (ADR-0015, amended): NFC on macOS only, since Windows and
Linux keep a composed and a decomposed name as two files and the key showed one; case by platform, with per-volume
detection decided against and its cost tested. Names Windows rewrites (a trailing dot or space, `NUL`) were opened
under another path, so an action on `photo.jpg.` would have hit `photo.jpg`; the index now hands out the exact path.
**Volumes:** the macOS list comes from the mount table without waiting on any share; Windows is tested on a
substituted drive and a mapped share; a fresh Linux account had no trash, now made on first use. **Media tools:**
ffmpeg, ffprobe and 7-Zip are found on macOS when the app starts from the Finder (Homebrew is not on that `PATH`).
**Wheel:** stepping (next file, tile size, lister rows) follows the distance travelled; wheel navigation had stepped
once per event because the picture took the throttle's state with it at every step. **E2E:** the viewer's seven
stale specs are repaired (34 tests), fixtures notice when a temp cleaner removed part of them, and the packaged
smoke test follows the picture into the media window. Measured: the name join costs about 10 ns per entry; startup
262 ms to ready-to-show; idle memory as in P01 (the benchmark opens Home, C00's record).

Open from P04: everything that needs a Mac (the volume list and tool folders there, "Put Back", a real trackpad, the
e2e run); startup and memory budgets on Linux and macOS; the commander's four e2e tests that predate the document
window (ADR-0033), one with a product question (Enter on a `.cmd`); the owner's word on case-sensitive folders and on
what the media window lacks against the full-screen viewer it replaced (copy, menu, rotate, prefetch: a step to the
next 12 MP picture takes 636 ms); `pnpm lint` fails on two files of `showcase/`.

Before that:
`P02 — Index scope: all entries, filtered per query` (`docs/shared/stages/P02-index-scope-profiles.md`), whose
query core was built on 2026-10-05 with C01 and which was taken up again on 2026-10-12 at the owner's request, right
after P01; implementation done the same day. ADR-0026 is accepted with amendments. Electron main names the calling
app on folder and query opens and the app on screen (`app.setVisible`); no renderer can. **Sessions** have an owner
and a budget each (viewer 8, commander 24, main 8): an app evicts only its own, where one budget of 8 let a
commander with tabs close the viewer's folder. **Watching** is by slot (the viewer's folder, a commander panel)
and only for the app on screen; a hidden app's folders are listed again 300 ms after it is shown, unless the other
app showed them too. A folder the commander opens outside a panel is no longer watched, and its open no longer
cancels the viewer's listing. Measured against the scanner that stored media only, on the same day: a media-only
100k folder scans as before, `flat-100k` (10 % other files) 12–17 % slower, a folder with 40 % media 2.9 times
as long; `query.page(256)` 1.5 ms at any offset in either scope; the viewer's first rows of a 100k folder
112–158 ms; the switch 4–5 ms. The viewer's index e2e spec runs again (5 of 5).

Open from P02: the owner's word on the `flat-100k` scan (the stage allows 10 %; the time is the 11 % more rows);
**the intermittent fault in the SQLite driver ended 3 of 12 runs of the index benchmark** (Stage 07's carried
item; it needs its driver or hardware decision); the benchmark had no links (the account cannot create them); the
Linux and macOS runs (CI). The viewer's stale e2e specs were repaired in Stage P04 (2026-10-12). The next stage is
the owner's choice (`docs/ROADMAP.md`).

Before that:
`P01 — Multi-app platform: one shell, app views, shared packages`
(`docs/shared/stages/P01-multi-app-platform.md`), started 2026-10-05 with the part Stage C00 needed and taken up
again on 2026-10-12 at the owner's request, after C10.5; implementation done the same day. The rest of the shared
renderer packages is extracted: `src/shared/renderer-core` has the bridge core (one `PanelythError` with the retry
hint and the details, the envelope handling, the way to the preload API) and the factories of the settings and
sidecar stores, and both apps are built on them; `src/shared/ui` has the menus, the chrome icons and the notice.
The commander's first sidecar status can no longer replace a newer one. The package boundaries are lint rules with
a test that proves they fire (ADR-0013, amended). A hidden viewer keeps a change of its folder aside until it is
shown, as the commander does. `pnpm bench:bundle` records bundle sizes. The viewer's tile e2e spec opens folders
again (9 of 9 green). Measured before and after: ready-to-show 266 → 256–259 ms, `system.ping` p95 0.2 ms, the 100k
tile scroll at 7 ms a frame with no long task and 80 or 204 tiles mounted, the first switch 177–191 ms and later
ones 4–5 ms; the viewer's JS grew by 671 bytes (0.09 %) and the commander's by 630 (0.07 %).

Open from P01: the owner's word on that growth (the stage says the bundle must not grow); the hidden viewer still
requests pages and thumbnails when the window is resized under the commander; the Linux and macOS runs (CI). The viewer's other e2e specs were repaired in Stage P04 (2026-10-12).

Before that:
`C10.5 — Tab sets, folder tree, FTP connections and compare selected files`
(`docs/commander/stages/C10.5-tabs-tree-ftp-compare.md`), started 2026-10-12 at the owner's request right after 16;
implementation done the same day. ADR-0037 is accepted with amendments. The tab bar is always there with a "+"
button; a tab can be renamed, duplicated and brought back after closing, and a panel's tabs (or both panels') are
saved as a named **tab set** and opened again in place of the tabs or after them. A **folder tree** sits beside the
panels (one that follows the active panel, or one per panel) on the viewer's tree store, moved to
`src/shared/renderer-core`. **FTP and FTPS** servers are panel locations: a fourth session source over a folder's
listing, an FTP client of our own, saved connections in `library.db` with passwords encrypted by Electron main
(no method returns one, and nothing is saved where the OS has no secret store), certificates shown by fingerprint,
transfers as `download`, `upload` and `remoteDelete` jobs in a lane per connection, and nothing that connects
without a command (a restored tab says "Not connected"). **Compare by content** takes any number of marked files
as one job with a result list, and the diff marks the change inside a line. The security review of the remote path
is in the stage document with no open blocking finding. Measured: a tree node with 1,000 subfolders expands in
10 ms; a remote folder of 10,000 entries shows its first rows in 20 ms at 78 bytes an entry; a gigabyte downloads
at 1.3 to 4.5 times `curl`'s speed and uploads at 1.0 to 1.2 times; a server that stops answering leaves the other
panel at 7 ms a frame and is stopped in 2 ms.

Open from C10.5: the owner's confirmation that FTP is on in the first release; the Linux and macOS runs (libsecret
and Keychain behind `safeStorage`), the race detector and the NVDA pass; the drive menu's places as tree roots, a
connection's features on screen, pause and resume of a transfer in an E2E scenario; many small files over FTP are
slower than `curl`.

Before that:
`16 — Image editor: batch mode` (`docs/viewer/stages/16-editor-batch.md`), started 2026-10-12 right after 15;
implementation done the same day. ADR-0036 is accepted with amendments. Several selected items open the editor in
batch mode ("Edit…" in the batch bar, the tile menu, Ctrl/Cmd+E): the edit list is a **recipe**, the picture on the
canvas one of up to twelve samples of the selection, and the four free-hand tools are out, with the reason. The
Output dialog says where the results go (next to the originals, one folder picked in main's dialog and named to the
renderer by a handle, or replacing the originals through the trash), what they are called (a template with tokens
and `{n}`) and what happens to a taken name; a plan from Go (`batch.plan`, one call, no pixels) shows the count, what
is skipped, the first names, the warnings and why a recipe cannot run. Run starts one `edit` job: at most four
pictures at a time on one core each, each written by the editor's own save (a batch's file is byte for byte the
editor's), with the decode memory from the budget previews use. A finished batch can be undone (its files go to the
trash; originals are never touched). Recipes are saved in `library.db`; six are built in. Measured: 5.9 pictures/s
on 12 MP JPEGs with four workers, a cancel in 0.16 s, the plan of 100,000 pictures in 157 ms, thumbnails 9 % slower
beside a running batch, no long task in the renderer.

Open from 16: the reports (Count colors, EXIF to CSV); recipe export and import and recipes with a picture across
restarts; the "Compare all" grid; mirroring subfolders; crop by ratio, trim borders and radii scaled to the
picture; an intermittent single-item failure seen once in a benchmark and not reproduced; the NVDA pass; the Linux
and macOS runs and the race detector (CI). With 16 the image editor's five stages are built; the next stage is the
owner's choice (`docs/ROADMAP.md`).

Before that:
`15 — Image editor: draw and retouch` (`docs/viewer/stages/15-editor-draw-retouch.md`), started 2026-10-12 right
after 14; implementation done the same day. Four operations where the user points at pixels: `draw` (one drawing is
a list of strokes: brush, eraser, line, arrow, rectangle, ellipse, text, fill), `clone`, `heal` (a spot, or from a
source; a copy corrected to the tone around the stroke) and `redeye`. Points are 0..1 of the picture, so a drawing
replays at any size, and none of the four runs in batch. The stroke in progress is drawn by the renderer at once
(26 ms at most from the pointer event on a 24 MP picture) and Go's frames follow every 51 ms; the layer of the
earlier strokes is kept, so a frame paints one stroke. Heal takes a blemish's error from 29 levels to 3.6. Red-eye
Auto finds pairs of pupils (`edit.eyes`) and adds an edit for each; its test set is synthetic, so it stays
interactive-only and Stage 16 omitted it.

Open from 15: space+drag to pan while a paint tool is open; a fixed clone source, in-place text editing and a
richer color picker; the NVDA pass; the Linux and macOS runs and the race detector (CI).

Before that:
`14 — Image editor: effects` (`docs/viewer/stages/14-editor-effects.md`), started 2026-10-12 right after 13;
implementation done the same day. Eight operations join the edit list: border, frame mask, watermark, obscure, lens,
bump map, sketch and oil painting, all sized relative to the picture so one list fits any picture. A watermark is
text with tokens (`{name}`, `{date}`, `{exif.model}`, …) in a font named by family, or a picture; a picture for a
watermark, a mask or a texture is picked in Electron main's dialog and the renderer gets an id and a thumbnail
token (`asset.pick`), never a path. Two font families are built in; the system's are listed by name
(`edit.fonts`). Obscure and Lens put their region and centre on the canvas, operable by keyboard. On a 24 MP
picture the effect sliders paint a frame every 40–61 ms at p95; a watermark and a border are saved onto 24 MP in
88 ms of pixel work.

Open from 14: dragging the watermark and a bump light handle on the canvas, drawing a polygon by clicks; a CJK text
test; an arm64 run of the golden hashes; the NVDA pass; the Linux and macOS runs and the race detector (CI).

Before that:
`13 — Image editor: color tools` (`docs/viewer/stages/13-editor-color.md`), started 2026-10-12 right after 12;
implementation done the same day. Thirteen operations join the edit list: lighting, colors, levels, curves,
grayscale, sepia, negative, replace color, swap channels, sharpen, blur, reduce noise and reduce colors. Consecutive
per-pixel operations run as one pass; radii are in pixels of the full picture, so preview and saved file agree; a
picture of at most 256 colors is saved as an indexed PNG or GIF. The tool rail shows five groups (Adjust, Color,
Detail, Geometry, Looks) and the panel lists a group's tools. Levels and Curves draw the histogram of the picture they
are given; eyedroppers read colors through Go (`edit.probe`) and show a loupe; twelve looks are thumbnails from one
request (`edit.thumbs`); Count colors (`edit.colors`) is exact. On a 24 MP picture a dragged color slider paints a
frame every 37–51 ms at p95 (budget 80 ms); a save with tone, curves and sharpening takes 1.3 s.

Open from 13: a full-resolution view of a region (a fine sharpening radius looks weaker in the preview of a large
picture than in the saved file); the zebra overlay, the before/after split, the levels handles on the histogram, the
Replace color mask and the order hint in the edit stack; the NVDA pass; the Linux and macOS runs and the race
detector (CI).

Before that:
`12 — Image editor foundation` (`docs/viewer/stages/12-editor-foundation.md`), started 2026-10-12 at the owner's
request right after C10; implementation done the same day. ADR-0035 is accepted with amendments: an **Edit** button
(focused viewer, preview pane, tile menu, the commander's media overlay and the media window) opens a full-window
editor; Go holds an edit session with a 2,560 px proxy, renders the edit list on request (latest revision wins, at
most three cached prefixes) and answers with a JPEG frame that main serves through a token; saving is an `editSave`
job that renders the source at full resolution and writes atomically, with Replace going through the trash. The
tools are rotate (any angle, straighten), flip, crop, resize, canvas size and DPI; the panels are the histogram, EXIF
and file properties. The `edit.*` methods are in the viewer's profile only. Opening a 24 MP JPEG: 0.21 s; a dragged
slider paints a frame every 37–40 ms at p95; saving 24 MP: 0.88 s; a session holds 72 MB.

Open from 12: the NVDA pass over the editor; the Linux and macOS runs and the race detector (CI); a full-resolution
view of a region (zoom beyond the proxy shows the proxy's pixels); the before/after split handle and the zebra
overlay; the tile-scroll check with an idle session (the viewer's tile e2e suite opens folders again since P01;
the check is still to be written).

Before that:
`C10 — Command line, tools and customization` (`docs/commander/stages/C10-command-line-and-customization.md`),
started 2026-10-11 at the owner's request right after C09; implementation done the same day. ADR-0027 is accepted in
full: main runs a typed line (`shell.run`) or a stored user command (`shell.runTool`) through the OS shell, only for
the commander's own view while it is shown, in a folder the sidecar resolves from an id; file names in user commands
are quoted per shell (for cmd.exe through environment variables). The command line has a history and `cd`; user
commands run from a customizable toolbar, a key or the menu of files; the panels have a Thumbnails view on tile parts
moved from the viewer to `src/shared/media-ui`; the commander's settings have five sections. The security review is
in the stage document with no open findings. Thumbnails view on 100,000 entries: at most 77 tiles mounted, no long
task; Enter to the command handed over: 0.5 ms.

Open from C10: the NVDA pass over the command line, the Thumbnails view and the settings; the Linux and macOS runs
(the `sh` quoting and the console window; CI); console programs started with Enter are not seen (Shift+Enter opens
a console). The viewer's e2e tile suite, which could not open a folder since C06, was repaired and ran green in
Stage P01 (2026-10-12).

Before that:
`C09 — Multi-rename, attributes and properties` (`docs/commander/stages/C09-multi-rename-and-attributes.md`), started
2026-10-11 at the owner's request right after C08; implementation done the same day. The rename engine in Go now
compiles two syntaxes to one plan (the viewer's pattern and Total Commander's masks; ADR-0021, amended); a
multi-rename is previewed page by page by the function that later applies it, runs as one `multiRename` job and can
be undone once (`undoRename`, a journal in the sidecar's memory); attributes, permissions and dates change through
`setAttributes` jobs; folder sizes are written in batches (ADR-0029, amended). The properties rows are shared by
both apps (`src/shared/ui`). Preview of 10,000 names after a key press: 3–10 ms in Go, about 9 ms in the app;
10,000 renames without a long task in the renderer.

Open from C09: the NVDA pass over its three dialogs; the Linux and macOS runs (permission bits, case-sensitive
volumes; CI); an undo journal that survives a restart; the first key press after the dialog opens (18–20 ms) and the
in-app rename at up to twice the job's own time (Stage P05).

Before that:
`C08 — Compare, synchronize and checksums` (`docs/commander/stages/C08-compare-and-sync.md`), started 2026-10-11 at
the owner's request while P04's items stay open; implementation done the same day. A compare of two trees is a query
session over its own rows (ADR-0017, amended); a sync applies the rows its table shows as one `sync` job that checks
every entry against what the compare saw; checksum files are created and verified by jobs, and two files are
compared by content as a paged text diff or a streamed job (ADR-0029, amended). Compare of two 100k-file trees: 241–249
ms (budget 3 s).

Open from C08: the NVDA pass over its three dialogs, and a sync on FAT/exFAT and on a network share (dates are checked
exactly as the compare read them; a P04 volume item).

Earlier (the first slice of the active stage):
`P04 — Cross-platform hardening` (`docs/shared/stages/P04-cross-platform.md`), started 2026-10-08 at the owner's
request while C07's manual items stay open. ADR-0032 is accepted: electron-builder packages the product (Windows NSIS,
macOS DMG and zip, Linux AppImage and tar.gz), `release.yml` builds Windows and macOS for every published GitHub
release, and `ci.yml` runs the suites and a packaged smoke test on all three OSes. The Linux pass fixed read-only
copies on Unix, filesystem-dependent entry ids, created times on Linux (`statx`), duplicate quick-access places, and
(in the commander) a dropped mark-by-mask and undone cursor keys during folder refreshes.

Before that:
`C07 — Archives` (`docs/commander/stages/C07-archives.md`), started 2026-10-07 right after C06 (find files, branch
view and quick filter; implementation done 2026-10-07). ADR-0030 is accepted: zip, tar, tar.gz, tar.bz2 and .gz are
read with the standard library, 7z, rar and others through an optional 7-Zip; an open archive is a query-session
source whose rows come from its listing in Go (amends ADR-0017 again), never from `index.db`. Copy out, unpack, pack
and test are jobs on the engine v2 queue.

Open from C07: a run with a real 7-Zip on the reference machine (the adapter is tested against a fake tool; the real
test skips without 7-Zip), and extracting a 1 GiB tar.gz at 0.60x the OS's tar (Go's gzip is the limit).

Open from C02 to C10: the NVDA pass (grid, Brief view, menus, dialogs, queue panel, quick view, lister, find dialog,
pack and unpack dialogs, the synchronize, text diff and checksum dialogs, the multi-rename, attributes and properties
dialogs, the command line, the Thumbnails view and the settings sections). Open from P03:
the Linux and macOS fast paths (P04).

Open from C01: the cold-cache 100k timings (470 / 366 ms on the first run after a build); the rest of P02
(per-app session budgets, visible-app watching) was built on 2026-10-12. Open from C02: the manual NVDA pass. P01's shared-package
extraction moved on with C02 (selection algebra, keymap engine, dialogs) and was completed on 2026-10-12.

Test runs on the reference machine hit intermittent native crashes of Node and Electron processes (access violations
in vitest workers, Playwright and pnpm itself) at random points since 2026-10-05; reruns pass. Together with the Stage
07 SQLite heap fault this points at the machine; see the C02 stage record.

The Stage 08 and 08.5 gates are still open: their implementation is done (2026-10-01), but their automated coverage
was never added (`docs/viewer/stages/08-product-polish.md`, `docs/viewer/stages/08.5-viewer-settings.md`).

Carried over from Stage 07: the intermittent modernc SQLite heap fault, which reproduces outside Panelyth and needs a
driver/hardware decision (`docs/viewer/stages/07-batch-and-metadata.md`). Seen again on 2026-10-12 (Stage P02): 3 of
12 runs of `cmd/indexbench` ended in an access violation inside the driver while a query was stepping.

Carried over: idle memory is still near the budget edge (Stage 08: 52.9 MB over the Electron floor, budget 60). Cold
scans are 12–15 % slower since Stage 05. Both are to be re-measured in Stage P05. An LGPL ffmpeg/ffprobe build ships
with the Windows and Linux packages since Stage P06 (ADR-0018, amended; macOS open).
