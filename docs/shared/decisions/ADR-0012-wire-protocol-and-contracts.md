# ADR-0012 — Wire Protocol and Contract Source of Truth

## Status

Accepted (Stage 00). Refines ADR-0002.

Amended 2026-10-05 (ADR-0027, proposed; ADR-0031): the renderer allowlist becomes per app view. Main keys each call by
the calling web contents, and method groups are tagged with the apps that may call them.

## Decision

### Transport (Electron main ↔ Go)

- The sidecar's stdin/stdout carry **length-prefixed frames**: a 4-byte big-endian length followed by a UTF-8 JSON payload.
- The maximum frame is **4 MiB** on both sides. A larger frame is a protocol error.
- Go writes nothing but frames to stdout. `os.Stdout` is redirected to stderr at startup, so stray prints
  cannot corrupt the stream. Logs are slog JSON on stderr, which Electron main appends to its log file.
- The first frame is `hello` (`protocol`, `pid`, `version`, `goVersion`, `cacheRoot`, `configRoot`). Main
  refuses a sidecar whose `protocol` differs from `PROTOCOL_VERSION`.

### Envelope

| Frame | Direction | Shape |
|---|---|---|
| `req` | main → Go | `{ t, id, m, p, deadlineMs? }` |
| `cancel` | main → Go | `{ t, id }` |
| `res` | Go → main | `{ t, id, ok: true, r }` or `{ t, id, ok: false, e: { code, message, retryable, details? } }` |
| `evt` | Go → main | `{ t, ch, seq, p }` (producers coalesce; never one event per file) |
| `hello` | Go → main | see above |

- `deadlineMs` is set from the caller's timeout, so Go stops work the caller has abandoned. A timeout or abort
  also sends `cancel`.
- Go bounds in-flight requests (default 64) and answers `BUSY` (retryable) beyond that. Main answers `BUSY`
  when the child's stdin buffer exceeds 8 MiB.
- Params are decoded strictly (unknown fields are rejected with `INVALID_ARGUMENT`).
- Handler panics are recovered and returned as `INTERNAL`.

### Renderer ↔ main

- One invoke channel `fv:invoke(method, params)` and one push channel `fv:event`.
- Main checks the sender (main frame, own origin compared by scheme+host, since `URL.origin` is `"null"` for
  `app:`), the method allowlist (`RENDERER_METHODS`, plus `DEV_RENDERER_METHODS` only when unpackaged
  and `FASTVIEW_DEV_METHODS=1`) and params, then forwards to Go or answers locally.
- Every call resolves to an `RpcEnvelope`. Errors never cross IPC as exceptions, and the renderer bridge turns
  envelopes into `FastViewError`.
- Preload exposes typed, namespaced functions (`window.fastview.system.ping()` …) and `onEvent` for known
  channels only. There is no generic invoke and no `ipcRenderer`.

### Source of truth

- `shared/contracts` (TypeScript) is **canonical**. Go structs mirror it.
- Drift is caught by **golden fixtures**: `shared/sidecar/internal/app/golden_test.go` captures real
  frames into `shared/contracts/fixtures/*.json` (`go test ./internal/app -run TestGoldenFrames -update`),
  and `shared/contracts/test/fixtures.test.ts` validates them with the runtime guards in `guards.ts`.
  Changing a contract therefore requires touching both sides and regenerating the fixtures.

## Why

- Length prefixes are robust to newlines inside payloads, allow exact size limits, and avoid scanning for delimiters.
- JSON keeps the protocol debuggable. Stage 00 measured it: `system.ping` round-trip p95 is 0.2 ms, and a 64 KB echo
  p50 is 0.6 ms end to end. The codec sits behind the frame layer and can change (for example to MessagePack) if Stage P05
  shows a need.
- Generating code from a schema was rejected for now: it adds a toolchain for a small API. The golden
  fixtures give the same safety for a fraction of the cost.
