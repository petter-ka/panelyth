# Commander Testing

Commander-specific scenarios, fixtures and safety tests. Layers, harness, isolation and benchmark rules are shared:
`docs/shared/TESTING.md`. E2E specs live in `src/shared/e2e/specs/commander/` and launch the commander with
`launchApp({ app: "commander" })` (Stage P01).

## End-to-end scenarios

1. Start: both panels open the home folder (first run) or the last session.
2. Enter a 100k-entry folder in one panel while the other panel stays responsive.
3. Scroll and hold arrow keys in a 100k listing; mounted rows stay bounded.
4. Sort by each column and back; folders stay first.
5. Mark with Insert, Space, Shift+arrows, masks, invert and select all; the status line counts match Go's.
6. Quick search jumps to the right entry with prefix, substring and wildcards.
7. Tabs, drive menu, hotlist and history survive a restart.
8. Copy a large file and many small files to the other panel; pause, resume, cancel; partial files are removed.
9. Copy onto existing files with each conflict policy; "ask" pauses only that job.
10. Move across volumes; rename in place; nested new folder; trash and permanent delete with confirmation.
11. Quick view and lister on images, videos, text (UTF-8, UTF-16, Latin-1), binary and a 2 GB log file.
12. Find files by name and content; feed results to a panel and copy from it; branch view.
13. Enter zip and tar.gz archives; extract, pack, test; refuse a zip-slip archive.
14. Compare and synchronize two trees; checksums create and verify.
15. Multi-rename preview, apply, undo.
16. Permission denied, missing folder, unplugged removable drive, unavailable network path.
17. Command line: `cd`, a recorded command (test shell mode), history.
18. Switch to the viewer and back by icon and by key: folder, cursor entry and marks carried over per
    `docs/shared/APP-SWITCHING.md`; same-folder switches keep each app's state; a copy keeps running across switches;
    a bookmark or theme change shows in both apps.

19. Tabs by mouse and by key: "+", rename, duplicate, close, reopen; save a tab set, restart, open it with replace
    and with add (Stage C10.5).
20. Folder tree: show one and two trees; expand, follow the panel, open a folder with Enter and by click, type to a
    node, drop files on a node; mounted rows stay bounded in `tree-50k` (Stage C10.5).
21. FTP: save a connection, restart, connect; browse a 10,000-entry folder; download and upload with pause, resume and
    cancel; a conflict; new folder, rename and delete on the server; a wrong password; a server that stops answering
    while the other panel stays responsive; a restored tab says "Not connected" (Stage C10.5). As built
    (`ftp.spec.ts`): pause and resume of a transfer are not in the scenario (the queue's pause is the one every job
    uses; cancel is in the benchmark, with the partial file gone), and the 10,000-entry folder is in the benchmark.
22. Compare by content: two marked files, one marked in each panel, and 20 marked files against the other panel with
    the result list and a diff opened from it (Stage C10.5).

## Safety tests

- The commander's preload exposes exactly its API (the `foundation.spec.ts` pattern), and the viewer's surface is
  unchanged apart from `app.switch` and the context methods.
- A commander-only method called from the viewer's app view is rejected, even though both share one main process.
- No action accepts a renderer-supplied path; destinations resolve from panel locations in Go.
- Programs never start on Enter without the confirmation (default setting); `shell.run` runs only on Enter in the
  command line, and `shell.runTool` only from a user command's button, key or menu entry. Under
  `PANELYTH_TEST_SHELL=record`, all are recorded and never executed.
- Main runs a command for the commander's own view only, while it is shown: a call from the viewer, from a hidden
  commander or with a path instead of a folder id is refused (`tools.spec.ts`).
- File names reach a user command's program as single arguments, whatever they hold: the unit tests hand hostile
  names (`a&b %PATH%.txt`, `-rf`, `'; rm -rf ~; echo '`) to a real program through the real shell of the platform.
- Recursive operations never follow links (a fixture with link cycles).
- Archive extraction never writes outside the target (zip-slip, absolute paths, links in tar).

Remote connections (Stage C10.5, ADR-0037; as built: `ftp.spec.ts`, `test/remote.test.ts` and `test/router.test.ts`
in the desktop package, `remote.test.tsx` in the commander, and the Go tests of `internal/remote`, `internal/jobs`
and `internal/app`; the stage document's security review names the test for each line):

- The viewer's app view is refused every `remote.*` method and the `download`, `upload` and `remoteDelete` jobs.
- No renderer method returns a password. After saving a connection, the clear password is in no file under the
  profile (`library.db` holds ciphertext only) and in no log line of main or the sidecar.
- Without a secure store (`safeStorage` unavailable, forced in the test), a password is not saved.
- A connection set to TLS fails against a server without TLS; it never continues unencrypted. A certificate that
  does not verify is refused until the user accepts its fingerprint; a changed pinned fingerprint is refused again.
- Names from the server with `..`, separators, absolute paths or control characters are not listed, and a download
  never writes outside its target.
- A PASV reply that names another host does not make the app connect to it.
- No connection is opened at startup, by session restore, or while the commander is hidden without a running job.
- Tests reach loopback only; no test opens a connection to another host.

## Fixtures

Built by `src/shared/sidecar/cmd/fixturegen` (extended in Stage P02/C01), cached under `<tmp>/panelyth-fixtures/`:

| Fixture | Contents | Stages |
|---|---|---|
| `mixed-100k` | 100k entries: media, documents, executables, hidden and system files, links | P02, C01, C02 |
| `tree-500k` | a deep tree with 500k mixed entries | C06 |
| `copy-small-10k`, `copy-large-4g` | copy throughput sets | P03, C04 |
| `text-2g`, `encodings` | lister files: huge log, UTF-8/16, Latin-1, binary (as built: one folder, `fixturegen -text-log-bytes 2147483648 -encodings`: `big.log`, UTF-8 with and without BOM, UTF-16 LE/BE, Windows-1252, binary, a 100 KB line, empty, `tool.cmd`, `tool.sh`) | C05 |
| `archives` | zip (ZIP64, UTF-8 names), tar.gz, zip-slip and zip-bomb samples | C07 |
| `sync-pair` | two trees with known differences (newer, missing, size, content) (as built: `fixturegen -sync-pair` writes `left/` and `right/`: newer on each side, another size at one date, the same size with other bytes, files and folders on one side only, an empty folder, two versions of a text; `-sync-entries 100000` writes `tree-a/` and `tree-b/` with about 3 % differences for the benchmark) | C08 |
| `rename-set` | multi-rename files (as built: `fixturegen -rename-scenario` writes `scenario/`: three pictures a minute apart, `notes.txt`, `taken.txt` and a folder; `-rename-files 10000` writes `files/` of empty pictures a second apart; `-rename-folders 1000` writes `folders/` with 20 files of 1 KiB each) | C09 |
| `links` | symlinks, junctions, a cycle | P02, C06 |
| `ftp-server` | a loopback FTP and FTPS server started by the harness over a generated tree: a 10,000-entry folder, UTF-8 and code-page names, a 1 GiB file, 1,000 small files, hostile names; switches for no MLSD, no TLS, a bad certificate, a wrong PASV host, a stall (as built: `src/shared/sidecar/cmd/ftpfixture` on `internal/remote/ftptest`, built and started by `ftp.spec.ts`; flags `-tls`, `-implicit`, `-user`, `-password`, `-stall`, `-no-mlsd`, `-discard-uploads`; it answers `stats` on its input with the sessions, commands and clear-text passwords it has seen. The spec writes the tree: `many/` of 10,000 files, `small/` of 1,000 × 10 KB and `big.bin` of 1 GiB, cached under `<tmp>/panelyth-fixtures/ftp-server`. Code-page names, hostile names and the wrong PASV host are the Go tests' fixtures) | C10.5 |
| `tree-wide` | a folder with 1,000 subfolders (the deep tree is `tree-50k`) (as built: written by `tabstree.spec.ts`) | C10.5 |

Fixtures are deterministic (fixed mtimes, fixed content). See the Storage Sense note in `docs/shared/TESTING.md`.
