// Mirrors src/shared/sidecar/internal/rpc/envelope.go (ErrorCode).
export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INVALID_PATH",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "UNSUPPORTED_MEDIA",
  "CORRUPT_MEDIA",
  "CACHE_ERROR",
  "DB_ERROR",
  "CANCELLED",
  "BUSY",
  "TIMEOUT",
  "SIDECAR_UNAVAILABLE",
  "PROTOCOL_MISMATCH",
  "METHOD_NOT_FOUND",
  "INTERNAL",
  // The image editor (Stage 12, ADR-0035).
  "EDIT_TOO_LARGE",
  "EDIT_UNSUPPORTED",
  "EDIT_SESSION_GONE",
  "TRASH_UNAVAILABLE",
  "EDIT_ASSET_INVALID",
  // The text editor (Stage C10.6, ADR-0046).
  "TEXTEDIT_SESSION_GONE",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface RpcErrorShape {
  code: ErrorCode
  message: string
  retryable: boolean
  details?: unknown
}

/** What every renderer-facing call resolves to. The renderer bridge unwraps it. */
export type RpcEnvelope<R> = { ok: true; r: R } | { ok: false; e: RpcErrorShape }
