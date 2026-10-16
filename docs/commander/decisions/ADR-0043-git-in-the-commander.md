# ADR-0043 — Git in the Commander

## Status

Accepted (2026-10-16), at the owner's request, outside the stage list, like ADR-0040, ADR-0041 and ADR-0042.
Amends ADR-0027 (the commander's profile gets the `git.*` methods) and ADR-0028 (rows show a Git status).

## Context

- The owner asked for Git support in the commander. A panel on a folder inside a Git repository should say so with
  an icon. The rows should show their Git status. The panel's bottom should offer the basic commands: status, stage,
  commit, pull, push and branches. The UX should be very good.
- Git's own data format and protocols are large (packs, the index, transports, credentials, hooks, merges). The Git
  that the user has installed is what their repositories, credential helpers and hooks are set up for.
- The sidecar already runs optional external tools (ffmpeg, ADR-0018; 7-Zip, ADR-0030) without console windows
  and with cancellation.
- Renderers never hand paths to an action (ADR-0027): actions take folder ids, entry ids or selection descriptors.
- Main's calls to the sidecar time out after 10 s by default; a pull or a push can take much longer, and a hook can
  run a while.

## Decision

- **The installed Git does the work.** The sidecar finds `git` (`PANELYTH_GIT`, a path or `off`; then PATH and the
  folders Git for Windows installs to). Without it the commander shows no Git UI and keeps working. Each run hides
  its console window and sets `GIT_TERMINAL_PROMPT=0`, so Git never waits for a typed password (a credential helper
  with a window of its own, such as Git Credential Manager, still works). Reads use `--no-optional-locks`, so reading
  status never writes into `.git` and never makes the watched folder change.
- **Status, per folder, read whole.** `git.status {dirId}` finds the repository by walking up from the folder for
  `.git` (a folder or a file: worktrees and submodules), with no process. It then runs one
  `git status --porcelain=v2 -z --branch --show-stash --untracked-files=normal --ignored=matching`. The repository's
  status is cached (concurrent asks share one run; a result younger than 750 ms is reused) and dropped by any Git
  operation. The answer is the folder's part only:
  - the branch, upstream, ahead/behind, stash count;
  - a state in progress (merging, rebasing, cherry-picking, reverting, bisecting);
  - counts of staged, changed, untracked and conflicted entries;
  - one mark per child that has a status. A folder takes the strongest status below it. A folder that is wholly
    untracked or ignored says so once (`inherited`) instead of naming each child. The marks are capped at 5,000.
- **Operations are background runs.** `git.run {dirId, op, …}` returns an `opId` at once. Its progress (Git's
  `--progress` lines: phase and percent) comes as `git.progress` events, coalesced like a search's. `git.cancel`
  stops it. The operations are `stage`, `unstage`, `discard`, `commit`, `pull` (fast-forward only, or `rebase` or
  `merge` when chosen), `push` (setting the upstream on the first push), `fetch` (all remotes, pruned), `switch` and
  `createBranch`.
  - Files come from a selection descriptor of the panel, or as indexes into the last change list (`git.changes`)
    that the commit dialog shows. Paths reach Git through `--pathspec-from-file` with NUL separators and `--`, never
    as options.
  - Branch names are checked with `git check-ref-format --branch` and against the branch list. A name that starts
    with `-` is refused.
  - A commit message goes in on stdin (`commit -F -`).
  - Discard restores tracked files from `HEAD`. It never deletes untracked files; the answer says how many it left.
- **Read-only lists:** `git.branches` (local and remote branches, the current one, upstreams, last commit) and
  `git.log` (the last commits, up to 100).
- **The commander only.** The `git.*` methods are in the commander's profile alone. The viewer and Panelyth System
  have none.
- **In the UI:**
  - The path bar shows a branch badge when the panel is in a repository.
  - Rows color their name and show a status letter (M, A, D, R, U, C, !). Folders with changes below show a dot.
  - A Git bar sits at the bottom of the panel: the branch (a menu to switch or create one), ahead/behind with a
    sync action, change counts, Commit, Pull, Push and More. It also shows the run in progress with Stop.
  - There is a commit dialog with the change list (tick to stage), the message, Amend, and "Commit and push".
  - The row menu gets Stage, Unstage and Discard changes.
  - Settings → Commander → "Show Git status" turns it all off.
- **Freshness:** the panel asks again when its folder changes, when its listing changes (debounced), when the
  commander comes back on screen or the window gets the focus, and after each run. Nothing polls.

## Consequences

- A repository with huge working trees costs one `git status` per change burst, run outside the UI thread and
  bounded (at most one per repository at a time, two repositories at once).
- No Git library is added to the sidecar; Git's own behavior (hooks, credentials, config) applies unchanged.
- Merges with conflicts, interactive rebases and history editing stay in the user's Git tools. The panel shows a
  conflicted state and the conflicted files, and says so.
