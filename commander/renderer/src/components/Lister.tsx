import { chordAllowedWhileTyping, eventChord } from "@panelyth/renderer-core"
import { ImageViewer, VideoPlayer } from "@panelyth/media-ui"
import { Tooltip } from "@panelyth/ui"
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { formatBytes } from "../features/format"
import { actionFor, type ActionId } from "../features/keymap"
import { LISTER_LANE } from "../features/media"
import { ENCODINGS, encodeQuery, findBytes, unitOf, type Encoding } from "../features/text"
import {
  closeLister,
  listerStep,
  setListerMode,
  useViewersStore,
  type ListerMode,
  type ListerState,
} from "../features/viewers"
import { HexView, TextView, type ByteMatch, type ByteViewHandle } from "./ByteViews"
import { useImageRequests } from "./QuickView"
import { useByteFile, type ByteFile } from "./useByteFile"

const MODES: readonly { mode: ListerMode; label: string; key: string }[] = [
  { mode: "text", label: "Text", key: "1" },
  { mode: "hex", label: "Hex", key: "2" },
  { mode: "image", label: "Image", key: "3" },
  { mode: "video", label: "Video", key: "4" },
]

const MODE_ACTIONS: Partial<Record<ActionId, ListerMode>> = {
  "lister.text": "text",
  "lister.hex": "hex",
  "lister.image": "image",
  "lister.video": "video",
}

/** Wrap is remembered from file to file (N / P) and between openings. */
let lastWrap = false

const chip =
  "h-6 rounded-md border border-border px-2 text-[0.6875rem] text-text enabled:hover:border-muted disabled:text-muted aria-pressed:border-accent aria-pressed:text-accent"
const field =
  "h-6 rounded-md border border-border bg-canvas px-1.5 text-[0.6875rem] text-text outline-none focus:border-accent"

/**
 * The lister (F3, Stage C05): a full window over the panels. Text (wrap,
 * encodings, find) and hex read byte windows through the file's token URL;
 * images and videos use the shared media components. Modes switch with
 * 1–4, N / P show the panel's next and previous file, Esc returns.
 */
export function Lister() {
  const l = useViewersStore((s) => s.lister)
  if (!l) return null
  return <ListerWindow key={l.item.id} l={l} />
}

type FindStatus =
  | { kind: "idle" }
  | { kind: "searching"; progress: number }
  | { kind: "notFound" }
  | { kind: "unencodable" }

function ListerWindow({ l }: { l: ListerState }) {
  const { item } = l
  const root = useRef<HTMLDivElement>(null)
  const view = useRef<ByteViewHandle>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const available = (m: ListerMode): boolean =>
    m === "text" ||
    m === "hex" ||
    (m === "image" && item.kind === "image") ||
    (m === "video" && item.kind === "video")
  const media = item.kind === "image" ? "image" : item.kind === "video" ? "video" : null
  const wantsBytes = l.mode === "text" || l.mode === "hex" || (l.mode === null && media === null)
  const file = useByteFile(item.id, wantsBytes)
  const detected = file.status === "ready" ? file.detection : null
  const mode: ListerMode | null =
    l.mode ?? media ?? (detected ? (detected.binary ? "hex" : "text") : null)

  const [encoding, setEncoding] = useState<Encoding | null>(null)
  const textEncoding = encoding ?? detected?.encoding ?? "utf-8"
  // The detected mark only applies to the detected encoding.
  const floor = encoding === null || encoding === detected?.encoding ? (detected?.bom ?? 0) : 0
  const [wrap, setWrap] = useState(lastWrap)
  const [position, setPosition] = useState(0)
  const topRef = useRef(0)
  const onPosition = useCallback((top: number, fraction: number) => {
    topRef.current = top
    setPosition(fraction)
  }, [])

  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [match, setMatch] = useState<ByteMatch | null>(null)
  const [status, setStatus] = useState<FindStatus>({ kind: "idle" })
  const search = useRef<AbortController | null>(null)

  useEffect(() => {
    root.current?.focus()
    return () => search.current?.abort()
  }, [])
  // Keys go to the view once it exists.
  useEffect(() => {
    if (mode === "text" || mode === "hex") view.current?.focus()
  }, [mode, file.status])

  const find = async (backward: boolean): Promise<void> => {
    if (file.status !== "ready" || (mode !== "text" && mode !== "hex")) return
    if (query === "") {
      setFindOpen(true)
      return
    }
    const enc = mode === "hex" ? "utf-8" : textEncoding
    const pattern = encodeQuery(query, enc)
    if (!pattern) {
      setStatus({ kind: "unencodable" })
      return
    }
    search.current?.abort()
    const abort = new AbortController()
    search.current = abort
    const unit = unitOf(enc)
    const from = backward
      ? (match?.start ?? topRef.current)
      : match
        ? match.start + unit
        : topRef.current
    setStatus({ kind: "searching", progress: 0 })
    try {
      const at = await findBytes(file.source, pattern, from, enc, {
        caseSensitive,
        backward,
        signal: abort.signal,
        onProgress: (progress) => setStatus({ kind: "searching", progress }),
      })
      if (abort.signal.aborted) return
      if (at < 0) setStatus({ kind: "notFound" })
      else {
        setStatus({ kind: "idle" })
        setMatch({ start: at, end: at + pattern.length })
      }
    } catch {
      if (!abort.signal.aborted) setStatus({ kind: "idle" })
    }
  }

  const run = (action: ActionId): boolean => {
    const modeFor = MODE_ACTIONS[action]
    if (modeFor) {
      if (available(modeFor)) setListerMode(modeFor)
      return true
    }
    switch (action) {
      case "lister.close":
        if (status.kind === "searching") {
          search.current?.abort()
          setStatus({ kind: "idle" })
        } else if (findOpen) {
          setFindOpen(false)
          view.current?.focus()
        } else closeLister()
        return true
      case "lister.next":
        void listerStep(1)
        return true
      case "lister.previous":
        void listerStep(-1)
        return true
      case "lister.wrap":
        setWrap((w) => (lastWrap = !w))
        return true
      case "lister.find":
        setFindOpen(true)
        setTimeout(() => findInput.current?.select(), 0)
        return true
      case "lister.findNext":
        void find(false)
        return true
      case "lister.findPrevious":
        void find(true)
        return true
    }
    return false
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const chord = eventChord(e.nativeEvent)
    const action = chord ? actionFor("lister", chord) : undefined
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement
    // In the find field only Esc, function keys and chords with Ctrl or Alt reach the lister.
    if (!action || !chord) return
    if (typing && action !== "lister.close" && !chordAllowedWhileTyping(chord)) return
    if (run(action)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`Lister: ${item.name}`}
      tabIndex={-1}
      data-testid="lister"
      data-entry={item.id}
      data-mode={mode ?? ""}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-40 flex flex-col bg-canvas outline-none"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-chrome px-2 text-xs">
        <Tooltip content={item.name}>
          <span className="min-w-0 flex-1 truncate text-text">
            {item.name}
            <span className="ml-2 text-muted">{formatBytes(item.sizeBytes)}</span>
          </span>
        </Tooltip>
        <div role="group" aria-label="View as" className="flex gap-1">
          {MODES.map((m) => (
            <Tooltip key={m.mode} content={`${m.label} (${m.key})`}>
              <button
                type="button"
                className={chip}
                aria-pressed={mode === m.mode}
                disabled={!available(m.mode)}
                onClick={() => setListerMode(m.mode)}
              >
                {m.label}
              </button>
            </Tooltip>
          ))}
        </div>
        {mode === "text" && (
          <>
            <select
              aria-label="Encoding"
              className={field}
              value={textEncoding}
              onChange={(e) => {
                setEncoding(e.target.value as Encoding)
                setMatch(null)
              }}
            >
              {ENCODINGS.map((enc) => (
                <option key={enc.value} value={enc.value}>
                  {enc.label}
                </option>
              ))}
            </select>
            <Tooltip content="Wrap lines (W)">
              <button
                type="button"
                className={chip}
                aria-pressed={wrap}
                onClick={() => setWrap((w) => (lastWrap = !w))}
              >
                Wrap
              </button>
            </Tooltip>
          </>
        )}
        {(mode === "text" || mode === "hex") && (
          <Tooltip content="Find (Ctrl+F)">
            <button type="button" className={chip} onClick={() => run("lister.find")}>
              Find
            </button>
          </Tooltip>
        )}
        <Tooltip content="Close (Esc)">
          <button type="button" className={chip} onClick={closeLister}>
            Close
          </button>
        </Tooltip>
      </div>
      {findOpen && (
        <form
          role="search"
          aria-label="Find in file"
          className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-chrome px-2 text-xs"
          onSubmit={(e) => {
            e.preventDefault()
            setMatch(null)
            void find(false)
          }}
        >
          <input
            ref={findInput}
            aria-label="Find"
            className={`${field} w-64`}
            value={query}
            spellCheck={false}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value)
              setStatus({ kind: "idle" })
            }}
          />
          <label className="flex items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            Match case
          </label>
          <span role="status" aria-live="polite" className="text-muted" data-testid="find-status">
            {status.kind === "searching"
              ? `Searching… ${Math.round(status.progress * 100)}%`
              : status.kind === "notFound"
                ? "Not found"
                : status.kind === "unencodable"
                  ? "The text can't be written in this encoding"
                  : ""}
          </span>
        </form>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <ListerBody
          mode={mode}
          file={file}
          l={l}
          encoding={textEncoding}
          floor={floor}
          wrap={wrap}
          match={match}
          viewRef={view}
          onPosition={onPosition}
        />
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-chrome px-3 text-[0.6875rem] text-muted">
        <span data-testid="lister-position">
          {mode === "text" || mode === "hex" ? `${Math.round(position * 100)}%` : ""}
        </span>
        {mode === "text" && (
          <span>{ENCODINGS.find((e) => e.value === textEncoding)?.label ?? textEncoding}</span>
        )}
        <span className="flex-1" />
        <span>N / P next and previous file · 1–4 view · Esc close</span>
      </div>
    </div>
  )
}

interface BodyProps {
  mode: ListerMode | null
  file: ByteFile
  l: ListerState
  encoding: Encoding
  floor: number
  wrap: boolean
  match: ByteMatch | null
  viewRef: RefObject<ByteViewHandle | null>
  onPosition: (top: number, fraction: number) => void
}

function ListerBody({
  mode,
  file,
  l,
  encoding,
  floor,
  wrap,
  match,
  viewRef,
  onPosition,
}: BodyProps) {
  const { item } = l
  if (mode === "image") return <ListerImage id={item.id} />
  if (mode === "video") return <ListerVideo id={item.id} name={item.name} />
  if (file.status === "loading" || mode === null)
    return <p className="p-4 text-center text-xs text-muted">Reading…</p>
  if (file.status === "failed")
    return (
      <p role="alert" className="p-4 text-center text-xs text-danger">
        This file can't be read: {file.message}
      </p>
    )
  if (mode === "hex")
    return (
      <HexView
        ref={viewRef}
        key={file.source.url}
        source={file.source}
        match={match}
        label={`Hex of ${item.name}`}
        onPosition={onPosition}
      />
    )
  return (
    <TextView
      ref={viewRef}
      key={`${file.source.url}-${encoding}`}
      source={file.source}
      encoding={encoding}
      floor={floor}
      wrap={wrap}
      match={match}
      label={`Text of ${item.name}`}
      onPosition={onPosition}
    />
  )
}

function ListerImage({ id }: { id: number }) {
  useImageRequests(id, LISTER_LANE)
  return <ImageViewer entryId={id} placeholder={null} lane={LISTER_LANE} />
}

function ListerVideo({ id, name }: { id: number; name: string }) {
  useImageRequests(id, LISTER_LANE)
  return (
    <VideoPlayer entryId={id} name={name} placeholder={null} playToken={null} lane={LISTER_LANE} />
  )
}
