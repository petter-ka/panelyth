import type { Thumb } from "@panelyth/contracts"
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  formatTime,
  problemFromCode,
  problemFromMediaError,
  SEEK_STEP_S,
  setMuted,
  setVolume,
  unsupportedDetail,
  useVideoPrefs,
  VOLUME_STEP,
  type VideoProblem,
} from "./video"
import { retry, useViewerImage, type FitLane } from "./viewerImages"
import {
  ExitFullscreenIcon,
  FullscreenIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  VideoGlyph,
  VolumeIcon,
} from "./icons"
import { mediaPort } from "./port"

interface VideoPlayerProps {
  entryId: number
  name: string
  /** The tile's poster, shown until the sharper pane poster is decoded. */
  placeholder: Thumb | null
  /** Changes when the user asked to play this video (Enter / double-click). */
  playToken: number | null
  /** With playToken: also enter full screen (double-click on the tile). */
  playFullscreen?: boolean
  /** Preview lane for Try again (the viewer's preview pane by default). */
  lane?: FitLane
}

const control =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-text enabled:hover:bg-raised disabled:text-muted"

/**
 * Local video playback (Stage 06, ADR-0009). Chromium plays the original
 * file from a panelyth-media token URL (HTTP Range, so seeking never reads
 * the whole file); no media bytes travel over IPC. The poster comes from
 * the Go poster cache (ADR-0018). Render with key={entryId}.
 *
 * Playback state lives here, not in a store: timeupdate fires about four
 * times a second and must only re-render this component.
 */
export function VideoPlayer({
  entryId,
  name,
  placeholder,
  playToken,
  playFullscreen = false,
  lane = "pane",
}: VideoPlayerProps) {
  const { fit, media } = useViewerImage(entryId)
  const { volume, muted } = useVideoPrefs()
  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)
  const [started, setStarted] = useState(false)
  const [mediaProblem, setMediaProblem] = useState<VideoProblem | null>(null)
  const [fullscreen, setFullscreen] = useState(false)

  const info = media?.status === "ready" ? media.media : null
  const url = info?.url ?? null
  const problem: VideoProblem | null =
    media?.status === "failed" ? problemFromCode(media.code) : mediaProblem
  const total = duration ?? (info && info.durationMs > 0 ? info.durationMs / 1000 : 0)
  const poster =
    fit?.status === "ready" && fit.decoded ? fit.thumb.url : (placeholder?.url ?? undefined)

  // Volume and mute follow the session preference.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume
    v.muted = muted
  }, [volume, muted, url])

  // Release the decoder and the file stream when this video goes away.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !url) return
    return () => {
      v.pause()
      v.removeAttribute("src")
      v.load()
    }
  }, [url])

  // Double-click on the tile: go full screen right away, while the click
  // still counts as a user gesture (the media URL may arrive later).
  const fullscreenToken = useRef<number | null>(null)
  useEffect(() => {
    const root = rootRef.current
    if (playToken === null || !playFullscreen || !root || fullscreenToken.current === playToken)
      return
    fullscreenToken.current = playToken
    root.focus()
    if (document.fullscreenElement !== root) void root.requestFullscreen().catch(() => undefined) // denied: play in the pane
  }, [playToken, playFullscreen])

  // Enter / double-click on the tile: play once the URL is known.
  const handledToken = useRef<number | null>(null)
  useEffect(() => {
    const v = videoRef.current
    if (playToken === null || !v || !url || handledToken.current === playToken) return
    handledToken.current = playToken
    rootRef.current?.focus()
    void v.play().catch(() => undefined)
  }, [playToken, url])

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  const toggle = (): void => {
    const v = videoRef.current
    if (!v || problem) return
    if (v.paused || v.ended) void v.play().catch(() => undefined)
    else v.pause()
  }
  const seek = (to: number): void => {
    const v = videoRef.current
    if (!v || !Number.isFinite(to)) return
    const t = Math.min(Math.max(0, to), total || v.duration || 0)
    v.currentTime = t
    setCurrent(t)
  }
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void rootRef.current?.requestFullscreen().catch(() => undefined)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Sliders handle their own arrows.
    if ((e.target as HTMLElement).tagName === "INPUT" && e.key.startsWith("Arrow")) {
      e.stopPropagation()
      return
    }
    const keys: Record<string, () => void> = {
      " ": toggle,
      k: toggle,
      ArrowLeft: () => seek(current - SEEK_STEP_S),
      ArrowRight: () => seek(current + SEEK_STEP_S),
      ArrowUp: () => setVolume(volume + VOLUME_STEP),
      ArrowDown: () => setVolume(volume - VOLUME_STEP),
      Home: () => seek(0),
      End: () => seek(total),
      m: () => setMuted(!muted),
      f: toggleFullscreen,
      // Electron leaves leaving HTML full screen to the page.
      ...(fullscreen ? { Escape: toggleFullscreen } : {}),
    }
    const action = keys[e.key]
    if (!action || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    e.stopPropagation()
    action()
  }

  const state = problem
    ? "error"
    : !url
      ? "loading"
      : playing
        ? "playing"
        : started
          ? "paused"
          : "ready"
  const unavailable = !url || !!problem

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={`Video player: ${name}`}
      data-testid="video-player"
      data-state={state}
      data-problem={problem ?? undefined}
      className="flex h-full w-full flex-col bg-canvas outline-none @container"
    >
      <div
        className="relative min-h-0 flex-1 bg-canvas"
        onDoubleClick={(e) => {
          if (!url || problem) return
          if (e.target instanceof Element && e.target.closest("button, input, [role=slider]"))
            return
          toggleFullscreen()
        }}
      >
        {url && !problem && (
          <video
            ref={videoRef}
            src={url}
            poster={poster}
            preload="metadata"
            playsInline
            className="absolute inset-0 size-full object-contain"
            data-testid="video-element"
            onClick={toggle}
            onPlay={() => {
              setPlaying(true)
              setStarted(true)
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
            onDurationChange={(e) => {
              const d = e.currentTarget.duration
              if (Number.isFinite(d)) setDuration(d)
            }}
            onLoadedMetadata={(e) => {
              // Chromium plays the audio of a file whose video codec it can't
              // decode: the element reports no picture although ffprobe saw one.
              if (e.currentTarget.videoWidth === 0 && info && info.width > 0) {
                e.currentTarget.pause()
                setMediaProblem("unsupported")
              }
            }}
            onError={(e) => setMediaProblem(problemFromMediaError(e.currentTarget.error?.code))}
          />
        )}
        {(!url || problem) && (
          <div className="absolute inset-0 flex items-center justify-center text-muted">
            {poster ? (
              <img
                src={poster}
                alt=""
                draggable={false}
                className={`size-full object-contain ${problem ? "opacity-30" : ""}`}
              />
            ) : (
              <VideoGlyph size={48} />
            )}
          </div>
        )}
        {problem && (
          <ProblemView
            problem={problem}
            detail={unsupportedDetail(info?.videoCodec ?? "", info?.audioCodec ?? "")}
            onOpen={() =>
              void mediaPort()
                .openWithSystem(entryId)
                .catch(() => undefined)
            }
            onRetry={() => {
              setMediaProblem(null)
              retry(entryId, lane)
            }}
          />
        )}
        {url && !problem && !started && (
          <button
            type="button"
            onClick={toggle}
            // Mouse shortcut only: the toolbar's Play is the accessible control.
            tabIndex={-1}
            aria-hidden="true"
            className="absolute top-1/2 left-1/2 flex size-12 -translate-1/2 items-center justify-center rounded-full border border-border bg-chrome/85 text-text hover:border-muted"
          >
            <PlayIcon size={22} />
          </button>
        )}
      </div>
      <div
        role="toolbar"
        aria-label="Playback controls"
        className="flex h-10 shrink-0 items-center gap-1 border-t border-border bg-chrome px-1.5"
      >
        <span
          className={unavailable ? "inline-flex" : "contents"}
          data-tooltip-content={playing ? "Pause (Space)" : "Play (Space)"}
        >
          <button
            type="button"
            className={control}
            onClick={toggle}
            disabled={unavailable}
            style={unavailable ? { pointerEvents: "none" } : undefined}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
        </span>
        <span
          className="shrink-0 px-1 text-[0.6875rem] text-muted tabular-nums"
          data-testid="video-time"
        >
          {formatTime(current)} / {formatTime(total)}
        </span>
        <Slider
          label="Seek"
          value={current}
          max={total}
          step={0.1}
          disabled={!url || !!problem || total <= 0}
          onChange={seek}
          valueText={`${formatTime(current)} of ${formatTime(total)}`}
          className="min-w-12 flex-1"
          testId="video-seek"
        />
        <button
          type="button"
          className={control}
          onClick={() => setMuted(!muted)}
          aria-label={muted ? "Unmute" : "Mute"}
          aria-pressed={muted}
          data-tooltip-content={muted ? "Unmute (M)" : "Mute (M)"}
        >
          {muted ? <MuteIcon /> : <VolumeIcon />}
        </button>
        <Slider
          label="Volume"
          value={muted ? 0 : volume}
          max={1}
          step={0.05}
          onChange={setVolume}
          valueText={`${Math.round((muted ? 0 : volume) * 100)}%`}
          className="hidden w-16 @[320px]:block"
          testId="video-volume"
        />
        <span
          className={unavailable ? "inline-flex" : "contents"}
          data-tooltip-content={fullscreen ? "Exit full screen (F)" : "Full screen (F)"}
        >
          <button
            type="button"
            className={control}
            onClick={toggleFullscreen}
            disabled={unavailable}
            style={unavailable ? { pointerEvents: "none" } : undefined}
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          >
            {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
        </span>
      </div>
    </div>
  )
}

interface SliderProps {
  label: string
  value: number
  max: number
  step: number
  disabled?: boolean
  onChange: (value: number) => void
  valueText: string
  className?: string
  testId: string
}

/** A native range input styled with the accent; keyboard and a11y come free. */
function Slider({
  label,
  value,
  max,
  step,
  disabled,
  onChange,
  valueText,
  className = "",
  testId,
}: SliderProps) {
  return (
    <input
      type="range"
      min={0}
      max={max > 0 ? max : 1}
      step={step}
      value={max > 0 ? Math.min(value, max) : 0}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={valueText}
      onChange={(e) => onChange(Number(e.currentTarget.value))}
      className={`h-1 cursor-pointer accent-accent disabled:cursor-default disabled:opacity-40 ${className}`}
      data-testid={testId}
    />
  )
}

function ProblemView({
  problem,
  detail,
  onOpen,
  onRetry,
}: {
  problem: VideoProblem
  detail: string
  onOpen: () => void
  onRetry: () => void
}) {
  const content: Record<VideoProblem, { title: string; text: string; action: ReactNode }> = {
    unsupported: {
      title: "This video can't be played here",
      text: detail,
      action: <ActionButton onClick={onOpen}>Open with default app</ActionButton>,
    },
    missing: {
      title: "This video can't be opened",
      text: "The file was moved, deleted or can't be read.",
      action: <ActionButton onClick={onRetry}>Try again</ActionButton>,
    },
    damaged: {
      title: "This video is damaged",
      text: "The file can't be read as a video.",
      action: <ActionButton onClick={onOpen}>Open with default app</ActionButton>,
    },
  }
  const c = content[problem]
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center"
      role="status"
      data-testid="video-problem"
    >
      <p className="text-sm font-medium">{c.title}</p>
      <p className="max-w-sm text-xs text-muted">{c.text}</p>
      <div className="mt-2">{c.action}</div>
    </div>
  )
}

function ActionButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-md border border-border bg-raised px-2.5 text-xs text-text hover:border-muted"
    >
      {children}
    </button>
  )
}
