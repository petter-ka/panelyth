// Frames exchanged between Electron main and the Go sidecar over stdio.
// Transport: 4-byte big-endian length prefix + UTF-8 JSON (ADR-0012).
import type { RpcErrorShape } from "./errors"

export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

export interface RequestFrame {
  t: "req"
  id: number
  m: string
  p: unknown
  deadlineMs?: number
}

export interface CancelFrame {
  t: "cancel"
  id: number
}

export type OutboundFrame = RequestFrame | CancelFrame

export interface ResponseOkFrame {
  t: "res"
  id: number
  ok: true
  r: unknown
}

export interface ResponseErrFrame {
  t: "res"
  id: number
  ok: false
  e: RpcErrorShape
}

export type ResponseFrame = ResponseOkFrame | ResponseErrFrame

export interface EventFrame {
  t: "evt"
  ch: string
  seq: number
  p: unknown
}

export interface HelloFrame {
  t: "hello"
  protocol: number
  pid: number
  version: string
  goVersion: string
  cacheRoot: string
  configRoot: string
  /** Root of the preview files that panelyth-thumb URLs resolve into. */
  thumbnailRoot: string
}

export type InboundFrame = ResponseFrame | EventFrame | HelloFrame
