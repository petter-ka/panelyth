# ADR-0037 — Remote Locations: FTP Connections as Folders

## Status

Accepted with amendments (2026-10-12, Stage C10.5, `docs/commander/stages/C10.5-tabs-tree-ftp-compare.md`). Proposed
the same day at the owner's request. The amendments are marked "Amended" below; the open points are settled at the
end. One point stays the owner's to confirm: FTP is on in the first release (see "Settled").

## Context

- The owner asked for FTP in the commander: connect, browse, transfer, and save connections. The BRS listed FTP as
  out of scope for the first release; this ADR is the decision that brings FTP and FTPS in. SFTP, WebDAV and cloud
  storage stay out.
- Listings, marks and jobs are built on query sessions, entry ids and selection descriptors (ADR-0017, ADR-0026).
  A file on a server is not a filesystem entry and must not be written into `index.db`. Archives had the same
  problem and solved it with a session source (ADR-0030).
- A server is slow, can hang, and is not trusted: its names, its certificate and its PASV replies are input.
- Credentials are a new kind of data for the product. `library.db` is a plain SQLite file (ADR-0016).
- The sidecar builds without cgo (ADR-0019). The renderer gets narrow typed APIs and never a secret (ADR-0027).

## Decision

### A remote folder is a session source

- The sidecar owns connections (`internal/remote`). A `Client` interface (list, read, write, rename, mkdir, delete)
  has one implementation, FTP; a later protocol adds an implementation, not a second design.
- A connected server is a panel location. `remote.open({ remoteId, path | dirId })` lists one folder (MLSD, else
  LIST) and returns its id; `query.open { remoteId, remoteDirId }` opens a session over it. The listing is held in
  memory and sorted, filtered and paged in Go, with its own rows (`query.ItemSource`, as archives have). The panel
  keeps its last folder of this computer behind the connection, as it does behind an archive.
- Remote entries get ids from a range of their own (from 7·2^50 up to 2^53: `7·2^50 + connection·2^20 + entry`), so no
  descriptor over a remote session resolves to a local file. Nothing is written to `index.db`.
- **Amended:** a connection keeps every folder it has listed for as long as it is open, so an entry keeps its id
  when its folder is read again (the cursor and the marks follow it). There is no LRU. A connection lists at most
  1,048,575 entries (2^20 − 1) in its life and at most 200,000 in one folder; beyond that it says "connect again".
  Measured: 78 bytes per listed entry. There is no watching: a listing is refreshed on Ctrl+R and after the app's
  own jobs in that folder.
- **Amended:** a new or renamed entry on a server is a new entry with a new id; the panel finds it by its name.

### Connections and secrets

- Saved connections are rows of a `connections` table in `library.db` (durable user data): name, group, host, port,
  encryption, user, start folder, local folder, passive or active, name encoding, transfer count, a pinned
  certificate fingerprint, and the password **ciphertext**.
- Passwords are encrypted and decrypted in Electron main with `safeStorage` (DPAPI, Keychain, libsecret). The
  sidecar stores the ciphertext as an opaque blob and receives the clear password only inside `remote.connect`, over
  its stdio pipe, and keeps it in memory for reconnects of that connection only.
- No method returns a password to a renderer, in any form. A renderer can set one (`remote.saveConnection`) or type
  one for a single connect. In the renderer a typed password lives in the field and in the call that sends it, never
  in a store or a setting. **Amended:** passwords are never logged because no log line carries `remote.*`
  parameters at all: main's module for them writes no log line, and the sidecar logs a connect with host, port and
  encryption only.
- Where `safeStorage` has no secure backend, passwords are not saved and are asked on every connect. There is no
  clear-text fallback. On Linux the `basic_text` backend (a fixed key) and an unknown backend count as no secure
  store.
- **Amended:** a stored password that cannot be decrypted here (another user profile, a changed keyring) is treated
  as not stored: the user is asked for it.

### Transport

- FTP and FTPS (explicit TLS: the default for a new connection; implicit TLS). A connection set to TLS fails when
  the server does not offer it; plain FTP is a choice the user makes per connection, and is labelled as unencrypted
  in the dialog and in the path bar.
- Certificates verify against the system roots. One that does not verify is refused with its fingerprint; the user
  may accept it once or pin it for the connection. A pinned fingerprint that changes is refused again.
- Passive mode by default (EPSV, then PASV). Data connections go to the control connection's host: the address in a
  PASV reply is ignored. Active mode is a per-connection option.
- Every dial, command and transfer has a timeout and a context (dial 10 s, a command 30 s, a transfer that moves
  no byte for 60 s). **Amended:** a connect and a folder listing can both be cancelled (`remote.cancel` by the
  attempt's number), so a server that stops answering never holds a panel.
- **Amended:** the FTP client is our own, on `net/textproto` (RFC 959, 2228, 2428, 3659): no library is added.

### Connection lifetime

- Nothing connects without a user command. Session restore brings a remote tab back as "Not connected".
- Per connection: one control connection for browsing and 1–4 for transfers (default 2). That is the bound on
  concurrency for a server (performance invariant 8).
- **Amended:** no keep-alive is sent. A socket of a connection closes after 5 minutes without a command; the next
  command opens it again with the kept password (a listing is retried once; other commands check an idle socket
  with NOOP first). The connection itself, with its listed folders, lives until the user disconnects or no panel,
  parked tab or tab record shows it any more; then the renderer closes it. At most 8 connections are open at once.
- A hidden commander does no browsing work; running jobs keep their connections.

### Operations

- `download`, `upload` and `remoteDelete` are jobs on the ADR-0029 queue, in a lane per connection, with progress,
  pause, cancel, conflict policies (by size and date) and per-item failures. A download writes a partial file and
  renames it into place; a transfer cut off is retried once and resumes with REST where the server offers it.
  **Amended:** an upload writes straight to its final name (FTP has no portable rename-over); a cancelled upload
  removes what it wrote. F6 is the same job with `move`: a source is removed only after its copy's size was checked.
- Names from a server are checked before they are listed (`remote.SafeName`: one path element in valid UTF-8, no
  `..`, no separator of either kind, no control character, so no name can start another command or leave its
  folder). An entry that fails is not listed and never transferred (the panel says how many were left out).
  Whether a name is valid on this computer is checked where a download writes it, and a download checks containment
  in its target again before it writes.
- Delete on a server is permanent (there is no trash); rename and new folder are single calls.
- Viewing a remote file downloads that one file to `<cache>/tmp/remote/` (at most 256 MiB a file and 16 files a
  connection, under a name of the app's own with the file's extension) and serves it through the token protocol, as
  archives do. The files go when the connection closes and at the next start. **Amended:** a file on a server is
  only ever shown (the lister, quick view, the media viewer): it has no path on this computer, so it is never
  started, revealed, edited or handed to a user command.
- Everything else (find, branch view, folder sizes, synchronize, compare by content, checksums, pack, multi-rename,
  attributes, the command line, user commands, the file clipboard, the hotlist, picture thumbnails) is not
  available on a connection in the first version and says so. **Amended:** the clipboard is in this list: its
  entries are shared with the viewer, which must never be handed an entry of a connection.
- **Amended:** no copy runs from one server to another; the files go through this computer.

### Profile

- Commander only (ADR-0027). The viewer is refused every `remote.*` method and the three job kinds. Actions take a
  connection id, a remote id and entry ids or descriptors. The two typed inputs, a host in quick connect and a path
  on the server, are validated in main (length, characters, port range) as a typed local path is.

## Why

- A session source reuses sorting, paging, marks, quick search, tabs and jobs for remote folders, as it did for
  archives, and keeps the filesystem index clean.
- `safeStorage` uses each OS's own secret store without a native module in the sidecar, and keeps secrets on the
  side of the bridge that renderers cannot reach.
- TLS by default and no silent fallback, because plain FTP sends the password in the clear.
- Ignoring the PASV address and checking names treat the server as untrusted input, the way archives are treated.

## Consequences

- A fourth session source in the shared query layer: the viewer's sessions must stay as fast as before (Stage C10.5
  regression check).
- A client of our own to maintain: server variety (LIST dialects, missing features) is ours to test. No new
  dependency.
- Main holds a secret in memory for the length of a `remote.connect` call, and the sidecar for the life of a
  connection. A crash dump of either could contain it.
- On Linux without a keyring, saved connections work but ask for the password every time.
- Features that assume a local path stay off on connections until they are designed for them one by one.
- SFTP needs host-key trust and an SSH library; it fits behind `Client` but is a decision of its own.

## Settled in Stage C10.5

- **The FTP library:** none. The client is our own on `net/textproto`, about 800 lines, with a test server of its own
  (`internal/remote/ftptest`). No license joins the notices. `golang.org/x/text` (already a dependency) reads names
  in a code page.
- **`basic_text` on Linux** counts as no secure store, and so does an unknown backend.
- **The id range:** remote entries take 7·2^50 … 2^53; compare rows are bounded below 7·2^50.
- **In the first release:** FTP is built on, without a setting. Nothing connects unless the user opens Connections
  or presses Connect, so a user who never does carries no risk from it. This is the owner's call to confirm before
  Stage C11; turning it off is one feature flag in the commander's keymap and drive bar.

## Security review

Recorded in the stage document ("Security review of the remote path"), with no open blocking finding.
