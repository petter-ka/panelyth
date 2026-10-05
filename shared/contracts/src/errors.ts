// Mirrors shared/sidecar/internal/rpc/envelope.go (ErrorCode).
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
