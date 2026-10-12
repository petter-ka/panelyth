# ADR-0017 — Query Sessions and Selection Descriptors

## Status

Accepted (Stage 01), by default: adopted from `docs/shared/ARCHITECTURE-ANALYSIS.md` C3 and C4. Selection
descriptors are specified here and implemented with multi-selection in Stage 05. Each session also keeps
the previous version's id list, so a descriptor made just before a refresh still resolves exactly. After
`query.invalidated`, the renderer calls `selection.rebase`, which returns the same entries as ranges of the new
version. Older versions are rejected (INVALID_ARGUMENT), never misapplied. `selection.info` (count, size) and
`selection.paths` (main only; ≤ 10,000, for the clipboard) resolve descriptors in Go.

Amended 2026-10-05: sessions have a budget per app inside the one sidecar (ADR-0026); a selection can be
carried to the other app with `selection.fromContext` (ADR-0031); and find results, archives and directory compares
add session sources (commander Stages C06–C08, ADR-0030).

Amended 2026-10-12 (Stage P02): **the budgets are built.** A session has an owner, named by Electron main on
`query.open`: the viewer (8 sessions), the commander (24) or main itself (8). Sessions over a source (find
results, archives, remote folders, compares) are the commander's. An owner over its budget loses its own least
recently used session; another owner's sessions are never evicted. The order is a use counter, not the clock. The
cap of "8 per sidecar" below is replaced by these.

Amended 2026-10-07 (Stage C06): the **session-source interface** is in place. A session is materialized either from
the index (the default) or from a `query.Source`, which returns the ordered ids for a descriptor (sorting and
filtering by `sort`, `nameMask` and `showHidden` in Go; `dirId` and `recursive` do not apply), the folded names
(quick search, marking by mask), and accepts a `Missing()` hint when a page could not load some of its ids. Index
changes never refresh source sessions directly; the source asks for a refresh when its own data changed. Find
results are the first source: the descriptor's `findId` selects it, the results are index entries (so every command
and selection descriptor works on them), and pages of sessions spanning folders (sources and recursive all-scope
listings) carry each row's `dirPath`. A finished search is forgotten when its last session closes. At most 8
searches are kept: beyond that the oldest finished one goes, preferring one without sessions; a panel whose search
was forgotten shows its folder again.

Amended 2026-10-07 (Stage C07): a source may also supply its **rows** (`query.ItemSource`): archive entries are not
in `index.db`, so their pages are built from the archive's listing in Go. A source that serves one folder
(`SingleFolder`) has no `dirPath` on its rows. Archive entry ids come from their own range (from 2^50 up, below
2^53), so a selection descriptor never mixes them up with index ids; Go resolves them to the open archive's entries
(ADR-0030).

Amended 2026-10-11 (Stage C08): a **directory compare** is the third source (`compare.dirs` returns its session with
its id). Its rows are not files but compared entries: they come from a third id range (from 3·2^51 up, above the
archive range, which got an upper bound, and below 2^53), so a descriptor over a compare's session resolves to
nothing in any job or entry method; only `compare.setAction` reads it. Page rows carry `diff { dir, state, action,
left, right }` next to the usual fields. The session lists the rows in the compare's own order (folder, then natural
name) and ignores the descriptor's sort; which rows it lists is a filter kept with the compare (`compare.show`), not
a second session. Because a filter or a direction change must show at once, a source may ask for an immediate
re-materialization (`RefreshNow`: the new snapshot is returned to the caller, and `query.invalidated` follows as
usual) instead of the throttled one. `Rows` returns every row of a session's current version with its position; the
flat compare behind Shift+F2 (`compare.marks`) reads two sessions with it and answers with one range descriptor per
session. At most 4 compares are kept, each with at most 500,000 rows.

Amended 2026-10-12 (Stage C10.5, ADR-0037): a **folder of a connection** (FTP, FTPS) is the fourth source. The
descriptor's `remoteId` and `remoteDirId` select it; `remote.open` lists the folder from the server first, and the
session sorts, filters and pages that listing in Go like any other, with its own rows (`query.ItemSource`,
`SingleFolder`). Its entries come from a fourth id range, from 7·2^50 up to 2^53 (`7·2^50 + connection·2^20 +
entry`); the compare range got an upper bound there. A descriptor over a remote session resolves only in the three
jobs made for it (`download`, `upload`'s target, `remoteDelete`), in `selection.info` and `props.get`, and in
`file.resolve` (a bounded temporary copy to view); every other job and entry method refuses it, and `entry.path`
never returns a path for it. An entry keeps its id while its folder is read again, so the cursor and the marks
follow it; a session is refreshed (`RefreshNow`) when its folder was listed again, never by the index. The viewer's
sessions are untouched: the source is reached only through the commander's descriptor fields, which main refuses
from the viewer.

## Context

Offset/limit over a table that is still growing during a scan shifts rows under the user. SQLite `OFFSET` is
O(offset), which is slow deep into 100k rows. Batch APIs that take `ids[]` would send 100k ids over IPC after
Ctrl+A.

## Decision

### Query sessions

- `query.open(descriptor)` runs one `SELECT id … ORDER BY …` and keeps the ordered ids in Go memory as
  `[]int64` (100k rows ≈ 800 KB). It returns `{ queryId, version, total }`.
- `query.page(queryId, offset, limit ≤ 1000)` slices the id list and loads the rows with `WHERE id IN (…)`,
  so every offset costs the same.
- Ordering is always deterministic: directories first, then the requested sort keys, then `id`.
- When the index changes under a session (scan batches, watcher reconciles), Go re-materializes it on a
  debounce (about 250 ms) and emits `query.invalidated { queryId, version, total }`. The renderer refetches only
  the pages it holds, and ids keep selection stable.
- Sessions are capped (8 per sidecar at first; per owner since Stage P02: the viewer 8, the commander 24, main 8;
  least-recently-used eviction within an owner) and closed explicitly with `query.close`.
  Per-window ownership comes with multi-window support.
- Descriptor fields in Stage 01: `dirId`, `recursive`, `sort: [{ field: name | modified | size | type,
  direction }]` and `kinds`. Search and more sort fields arrive in Stage 05.

### Selection descriptors (specified now, implemented later)

Batch operations take `{ queryId, version, ranges: [start, end)[], include: id[], exclude: id[] }`, and Go
resolves it. The renderer never sends a list of every id.
