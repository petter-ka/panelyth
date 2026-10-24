# Commander Performance

Commander-specific budgets and the benchmarks that check them. Platform budgets (startup, idle memory, IPC, paging,
long tasks) are in `docs/shared/PERFORMANCE.md` and apply here too. Results go to `src/shared/bench/results/stage-C<nn>-…`.

These are starting targets for the reference machine (i9-13900K, NVMe, Windows 11). Each stage calibrates them on the
reference machine and one low-end machine, and records the result in its stage document.

## Budgets

### Listing and navigation

| Metric | Budget |
|---|---|
| Enter a cached folder (≤ 1,000 entries) → rows painted | p95 < 50 ms |
| Enter an uncached folder (1,000 entries, SSD) → first rows painted | p95 < 150 ms |
| Enter a 100k-entry folder → first rows painted | < 300 ms; the rest streams in without long tasks |
| Mounted rows per panel | ≤ visible rows + 2 × overscan (≤ 150 at 4K height) |
| Cursor move (one key press) → painted | ≤ 1 frame (16 ms) |
| Held arrow key on a 100k listing | no long tasks > 50 ms; no frame gaps > 50 ms |
| Tab (switch panel) → focus visible | ≤ 1 frame |
| Sort change on a 100k listing → first page | < 300 ms |
| Quick search keystroke → cursor on the match (100k) | p95 < 50 ms |
| Hidden-files toggle or quick filter on 100k | < 300 ms to first page; no rescan |
| Both panels restored at startup | < 1.3 s from launch to both listings painted |
| Switch from the viewer (view exists) → rows painted | ≤ 1 frame, plus the cached-folder budget if the folder changes |
| First switch from the viewer (view created) → interactive | < 800 ms (`docs/shared/APP-SWITCHING.md`) |

### File operations (on the P03 engine)

| Metric | Budget |
|---|---|
| One 4 GB file, same volume | ≥ 90 % of the OS copy's throughput on the same machine |
| 10,000 × 10 KB files | ≥ 3× Stage 07's 12.4 MB/s, and within 2× of the OS copy's time |
| Memory per running job | ≤ 64 MB |
| Renderer during any job | no long tasks > 50 ms; both panels navigable |
| Pause / cancel → effective | < 200 ms |
| Progress events | ≤ 4 Hz per job (coalesced) |

### Viewers and tools

| Metric | Budget |
|---|---|
| Quick view: cursor settles → image shown (cached preview) | p95 < 100 ms |
| Lister: open a 2 GB text file → first screen | < 200 ms, bounded memory (byte windows) |
| Folder size of a 100k-file tree | ≥ 50k entries/s warm; cancel < 200 ms |
| Find by name over a 500k-entry tree | first result < 300 ms; ≥ 100k entries/s |
| Find by content | ≥ 70 % of sequential read speed, bounded memory |
| Zip with 100k entries → listing | < 1 s; ≤ 100 bytes per entry in memory |
| Compare two 100k-entry trees by name/size/date | < 3 s |

### Tree, tabs and connections (Stage C10.5)

The server is the loopback fixture (`docs/commander/TESTING.md`), so the numbers measure the app, not a network.
All of these pass as of 2026-10-12 (Windows; the stage document has the numbers). Upload throughput is measured
against a server that receives without writing (`ftpfixture -discard-uploads`), with the app and `curl` taking
turns and the best run of each counted: a server that writes to the same disk measures that disk, not the app.

| Metric | Budget |
|---|---|
| Expand a tree node with 1,000 subfolders → rows painted | p95 < 100 ms |
| Mounted tree rows | ≤ visible rows + 2 × overscan |
| Held arrow key in a tree of 10,000 visible nodes | no long tasks > 50 ms |
| Enter a folder with the tree shown | the listing budgets above, unchanged (the tree follows afterwards) |
| Open a tab set of 16 tabs → the visible tab painted | the cached-folder budget; one session opened |
| Remote folder with 10,000 entries → first rows painted | < 500 ms |
| Memory per remote entry | ≤ 120 bytes |
| Download or upload of one 1 GiB file | ≥ 80 % of `curl`'s throughput on the same machine |
| A server that does not answer: the other panel's cursor | ≤ 1 frame; Cancel effective < 200 ms |
| Renderer during a transfer | no long tasks > 50 ms; both panels navigable |
| Compare by content of 1,000 pairs of small files | recorded; one job, no long task in the renderer |

### Text editor (Stages C10.6–C10.9, ADR-0046)

The editor window's own budgets; the commander's are unchanged by it (its bundle does not grow).

| Metric | Budget |
|---|---|
| F4 on a 1 MB Markdown file → text painted in the editor window | < 300 ms after the window shows |
| Keystroke → paint, 1 MB Markdown | p95 ≤ 16 ms; no long tasks > 50 ms while typing |
| Ctrl+S of 1 MB (local) → "Saved" | ≤ 150 ms |
| Word count of 1 MB | off the keystroke path: never a long task |
| The viewer's and the commander's bundles | unchanged (`pnpm bench:bundle`) |

## Benchmarks per stage

| Stage | Benchmarks |
|---|---|
| C00 | first and later switches from the viewer; idle memory with both app views; the viewer's startup unchanged |
| C01 | folder enter (1k cached/uncached, 100k), 100k scroll in both panels, sort change, switch with a folder change |
| C02 | held-key cursor on 100k, quick search latency, mark all and invert on 100k, selection carry-over (10,000) |
| C03 | tab switch, drive menu with network drives, session restore |
| C04 | the P03 copy benchmarks through the UI, plus renderer long tasks during copies |
| C05 | quick view follow, lister open and scroll on 2 GB text |
| C06 | find by name and content, branch view of `tree-50k`, quick filter |
| C07 | list, extract and pack: 100k-entry zip, 1 GB tar.gz |
| C08 | compare 100k trees, hashing throughput |
| C09 | multi-rename preview and apply on 10k files; folder sizes for a panel of 1,000 folders |
| C10 | command line start-up cost; thumbnails view scroll (viewer tile budgets) |
| C10.5 | tree expand and held key, folder enter with the tree shown, tab set open, remote listing and transfers against `curl`, a dead server, multi-file compare; the viewer's sidebar tree on the shared code |
| C10.6 | editor open, typing and save of 1 MB Markdown; the sidecar's commit benchmark (`internal/textedit`); bundles |

## Rules

- Profile first, change one thing, measure again (`docs/shared/PERFORMANCE.md`).
- Benchmarks compare against the OS's own tools on the same machine wherever one exists (copy, hashing, archive tools).
- Missing measurements are reported as missing, never estimated.
