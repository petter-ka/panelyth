import type {
  EventChannel,
  EventMap,
  RpcEnvelope,
  TextEditCheckResult,
  TextEditCommitResult,
  TextEditorApi,
  TextEditorCommitParams,
  TextEditorExportParams,
  TextEditorExportResult,
  TextEditorSession,
} from "@panelyth/contracts"
import { vi } from "vitest"

// A TextEditorApi for tests: records writes and commits, answers commits from
// a queue, and emits events like main does.

export const VERSION_A = "a".repeat(64)
export const VERSION_B = "b".repeat(64)
export const VERSION_C = "c".repeat(64)

export function session(patch: Partial<TextEditorSession> = {}): TextEditorSession {
  return {
    name: "notes.md",
    sizeBytes: 12,
    version: VERSION_A,
    encoding: "utf-8",
    bom: 0,
    lineEnding: "lf",
    src: `panelyth-media://m/${"0".repeat(32)}`,
    theme: "dark",
    style: "classic",
    lang: "en",
    readOnly: false,
    ...patch,
  }
}

const ok = <R>(r: R): RpcEnvelope<R> => ({ ok: true, r })

export interface FakeApi extends TextEditorApi {
  writes: { seq: number; text: string }[]
  commits: TextEditorCommitParams[]
  dirtyCalls: boolean[]
  closes: boolean[]
  /** What the next commits answer, in order; then "saved" with VERSION_B. */
  commitAnswers: (TextEditCommitResult | RpcEnvelope<TextEditCommitResult>)[]
  disk: TextEditCheckResult["disk"]
  currentSession: TextEditorSession
  emit<C extends EventChannel>(channel: C, payload: EventMap[C]): void
  /** Fails the next write with this envelope. */
  failWrite: RpcEnvelope<never> | null
  /** Stage C10.7: the picture chunks sent, the names committed, the links asked about. */
  assetChunks: { seq: number; size: number }[]
  assetNames: string[]
  imageLinks: string[][]
  /** The exports asked for, and the answer of the next one (saved as notes.pdf by default). */
  exports: TextEditorExportParams[]
  exportAnswer: RpcEnvelope<TextEditorExportResult> | null
}

export function fakeApi(start: TextEditorSession = session()): FakeApi {
  const listeners = new Map<string, Set<(p: never) => void>>()
  const api: FakeApi = {
    writes: [],
    commits: [],
    dirtyCalls: [],
    closes: [],
    commitAnswers: [],
    disk: { version: start.version, sizeBytes: start.sizeBytes, mtimeNs: 1 },
    currentSession: start,
    failWrite: null,
    assetChunks: [],
    assetNames: [],
    imageLinks: [],
    exports: [],
    exportAnswer: null,
    // The window's frame (ADR-0045): no title strip of its own in tests.
    frame: {
      titleBar: false,
      state: vi.fn(async () =>
        ok({
          maximized: false,
          fullScreen: false,
          shown: true,
          minimizable: true,
          maximizable: true,
        }),
      ),
      control: vi.fn(async () => ok({ ok: true })),
    },
    session: vi.fn(async () => ok(api.currentSession)),
    write: vi.fn(async (seq: number, text: string) => {
      if (api.failWrite) {
        const failure = api.failWrite
        api.failWrite = null
        return failure
      }
      api.writes.push({ seq, text })
      return ok({ ok: true as const })
    }),
    commit: vi.fn(async (params: TextEditorCommitParams) => {
      api.commits.push(params)
      const next = api.commitAnswers.shift()
      if (next && "ok" in next) return next
      return ok(
        next ?? {
          status: "saved" as const,
          encoding: params.asUtf8 ? ("utf-8" as const) : api.currentSession.encoding,
          version: VERSION_B,
          sizeBytes: 1,
          mtimeNs: 2,
        },
      )
    }),
    check: vi.fn(async () => ok({ disk: api.disk })),
    setDirty: vi.fn(async (dirty: boolean) => {
      api.dirtyCalls.push(dirty)
      return ok({ ok: true as const })
    }),
    close: vi.fn(async (discard: boolean) => {
      api.closes.push(discard)
      return ok({ ok: true as const })
    }),
    assetChunk: vi.fn(async (seq: number, data: Uint8Array) => {
      api.assetChunks.push({ seq, size: data.byteLength })
      return ok({ ok: true as const })
    }),
    assetCommit: vi.fn(async (name: string) => {
      api.assetNames.push(name)
      return ok({ link: `assets/${name || "image"}.png`, reused: false })
    }),
    resolveImages: vi.fn(async (links: string[]) => {
      api.imageLinks.push(links)
      return ok({
        images: links.map((link) => ({
          link,
          src: link.startsWith("assets/") ? `panelyth-media://m/${"1".repeat(32)}` : null,
        })),
      })
    }),
    exportPdf: vi.fn(async (params: TextEditorExportParams) => {
      api.exports.push(params)
      return api.exportAnswer ?? ok({ saved: true, name: "notes.pdf" })
    }),
    onEvent(channel, listener) {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      const fn = listener as (p: never) => void
      set.add(fn)
      return () => set.delete(fn)
    },
    emit(channel, payload) {
      listeners.get(channel)?.forEach((l) => l(payload as never))
    },
  }
  return api
}
