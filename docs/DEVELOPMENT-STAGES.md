# Development Stages

Only one stage is active at a time, across all tracks. The order across tracks is in `docs/ROADMAP.md`.

## Tracks and stage IDs

| Track | Stage IDs | Stage documents | Bench result IDs |
|---|---|---|---|
| Viewer | `00`…`08.6` (history), `12`…`16` (image editor); next new stage `17` | `docs/viewer/stages/` | `stage-03-…`, `stage-08.6-…`, `stage-12-…`, `stage-13-…`, `stage-14-…`, `stage-15-…`, `stage-16-…` |
| Platform | `P01`…`P06` | `docs/shared/stages/` | `stage-P01-…` |
| Commander | `C00`…`C11` | `docs/commander/stages/` | `stage-C00-…` |

- The viewer stages 00–08.6 also built most of the shared platform; their records stay in the viewer track.
- The viewer's planned Stages 09, 10 and 11 became P04, P05 and P06 (2026-10-05, ADR-0025). Viewer numbers 09–11 are
  retired.
- Viewer Stages 12–16 (2026-10-11, owner request) are the image editor (`docs/viewer/IMAGE-EDITOR.md`; ADR-0035,
  accepted in Stage 12, and ADR-0036, accepted with amendments in Stage 16). The owner scheduled them on 2026-10-12,
  in order, after C10.
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
| P01 | Multi-app platform: one shell, app views, shared packages | 08.6 | in progress (minimal part done) |
| P02 | Index scope: all entries, filtered per query | P01 | partly done (query core in code; session budgets and visible-app watching open) |
| P03 | File-operation engine v2 | P02 | implementation done (2026-10-06); Linux/macOS paths in P04 |
| P04 | Cross-platform hardening (formerly 09) | P03 and the app stages in scope | in progress: packaging, CI, release builds and the Linux pass done (2026-10-08) |
| P05 | Performance hardening (formerly 10) | P04 | planned |
| P06 | Release engineering (formerly 11) | P05 | planned |

### Commander

| Stage | Name | Depends on | Status |
|---|---|---|---|
| C00 | Foundation and the app switch | P01 | done (2026-10-05) |
| C01 | Panels and listing | C00, P02 | implementation done; cold-cache 100k timings and the rest of P02 open |
| C02 | Keyboard, marks and quick search | C01 | implementation done; the NVDA pass and the C01 open items remain |
| C03 | Drives, tabs, hotlist, history and session | C02 | implementation done (2026-10-06); the NVDA pass remains |
| C04 | File operations | C03, P03 | implementation done (2026-10-06); the NVDA pass remains |
| C05 | Quick view, lister, open and edit | C04 | implementation done (media routing added 2026-10-09); the NVDA pass remains |
| C06 | Find files, branch view and quick filter | C05 | implementation done (2026-10-07); the NVDA pass remains |
| C07 | Archives | C06 | implementation done (2026-10-07); the NVDA pass and a run with a real 7-Zip remain |
| C08 | Compare, synchronize and checksums | C07 | implementation done (2026-10-11); the NVDA pass and a FAT/network run of a sync remain |
| C09 | Multi-rename, attributes and properties | C08 | implementation done (2026-10-11); the NVDA pass and the Linux and macOS runs remain |
| C10 | Command line, tools and customization | C09 | implementation done (2026-10-11); the NVDA pass, the Linux and macOS runs and the viewer's e2e tile suite remain |
| C11 | Commander release | C10, P04, P05, P06 | planned |

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
overlay; the tile-scroll check with an idle session (the viewer's tile e2e suite, open since C06).

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
(the `sh` quoting and the console window; CI); the viewer's e2e tile suite, which cannot open a folder since C06;
console programs started with Enter are not seen (Shift+Enter opens a console).

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

Earlier:
`P04 — Cross-platform hardening` (`docs/shared/stages/P04-cross-platform.md`), started 2026-10-08 at the owner's
request while C07's manual items stay open. ADR-0032 is accepted: electron-builder packages the product (Windows NSIS,
macOS DMG and zip, Linux AppImage and tar.gz), `release.yml` builds Windows and macOS for every published GitHub
release, and `ci.yml` runs the suites and a packaged smoke test on all three OSes. The Linux pass fixed read-only
copies on Unix, filesystem-dependent entry ids, created times on Linux (`statx`), duplicate quick-access places, and (in the commander)
a dropped mark-by-mask and undone cursor keys during folder refreshes. Open: the viewer's e2e specs (since C06), the first Windows and macOS CI run,
and the volume, Unicode, media-tool and budget items of the stage.

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

Open from C01: the cold-cache 100k timings (470 / 366 ms on the first run after a build) and the rest of P02
(per-app session budgets, visible-app watching). Open from C02: the manual NVDA pass. P01's shared-package
extraction moved on with C02 (selection algebra, keymap engine, dialogs) but is not complete.

Test runs on the reference machine hit intermittent native crashes of Node and Electron processes (access violations
in vitest workers, Playwright and pnpm itself) at random points since 2026-10-05; reruns pass. Together with the Stage
07 SQLite heap fault this points at the machine; see the C02 stage record.

The Stage 08 and 08.5 gates are still open: their implementation is done (2026-10-01), but their automated coverage
was never added (`docs/viewer/stages/08-product-polish.md`, `docs/viewer/stages/08.5-viewer-settings.md`).

Carried over from Stage 07: the intermittent modernc SQLite heap fault, which reproduces outside Panelyth and needs a
driver/hardware decision (`docs/viewer/stages/07-batch-and-metadata.md`).

Carried over: idle memory is still near the budget edge (Stage 08: 52.9 MB over the Electron floor, budget 60). Cold
scans are 12–15 % slower since Stage 05. Both are to be re-measured in Stage P05. Shipping an LGPL ffmpeg/ffprobe build
is a Stage P06 packaging task (ADR-0018).
