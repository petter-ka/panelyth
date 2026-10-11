import type { ErrorCode } from "@panelyth/contracts"
import { create } from "zustand"
import { t } from "@panelyth/i18n"

/** "1:05", "12:00", "1:02:03" — hours only when needed. NaN/∞ shows "0:00". */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

const CODEC_NAMES: Record<string, string> = {
  h264: "H.264",
  hevc: "H.265 (HEVC)",
  vp8: "VP8",
  vp9: "VP9",
  av1: "AV1",
  mpeg4: "MPEG-4 Part 2",
  mpeg2video: "MPEG-2",
  mpeg1video: "MPEG-1",
  prores: "Apple ProRes",
  dnxhd: "Avid DNxHD",
  wmv3: "Windows Media Video 9",
  vc1: "VC-1",
  theora: "Theora",
  mjpeg: "Motion JPEG",
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  vorbis: "Vorbis",
  flac: "FLAC",
  ac3: "Dolby Digital (AC-3)",
  eac3: "Dolby Digital Plus",
  dts: "DTS",
  pcm_s16le: "PCM",
}

/** A readable codec name ("hevc" → "H.265 (HEVC)"); unknown names pass through. */
export function codecName(codec: string): string {
  return CODEC_NAMES[codec] ?? codec.toUpperCase()
}

/**
 * Why a video cannot be shown, as the player presents it:
 * - unsupported: Chromium cannot decode the format (open it elsewhere),
 * - missing: moved, deleted or unreadable (try again),
 * - damaged: the file cannot be read as a video at all.
 */
export type VideoProblem = "unsupported" | "missing" | "damaged"

/** Maps a media.open failure. */
export function problemFromCode(code: ErrorCode): VideoProblem {
  if (code === "NOT_FOUND" || code === "PERMISSION_DENIED" || code === "INVALID_PATH")
    return "missing"
  if (code === "CORRUPT_MEDIA") return "damaged"
  return "unsupported"
}

/** Maps HTMLMediaElement.error.code (MediaError constants). */
export function problemFromMediaError(code: number | undefined): VideoProblem {
  // 2 = MEDIA_ERR_NETWORK: the protocol could not read the file (moved / deleted).
  if (code === 2) return "missing"
  // 3 = DECODE, 4 = SRC_NOT_SUPPORTED, anything else: Chromium can't play it.
  return "unsupported"
}

/** The detail line for an unsupported video, naming the codec when known. */
export function unsupportedDetail(videoCodec: string, audioCodec: string): string {
  if (videoCodec)
    return t("{codec} video isn't supported by the built-in player.", {
      codec: codecName(videoCodec),
    })
  if (audioCodec)
    return t("{codec} audio isn't supported by the built-in player.", {
      codec: codecName(audioCodec),
    })
  return t("This format isn't supported by the built-in player.")
}

/**
 * Volume, mute and repeat carry from one video to the next, not per file, and
 * persist across restarts and across the apps and windows (videoPrefs.ts).
 */
export interface VideoPrefs {
  volume: number
  muted: boolean
  /** Repeat the video when it ends. */
  loop: boolean
}

export const useVideoPrefs = create<VideoPrefs>(() => ({ volume: 1, muted: false, loop: false }))

export function setVolume(volume: number): void {
  const v = Math.min(1, Math.max(0, volume))
  useVideoPrefs.setState({ volume: v, muted: v === 0 })
}

export function setMuted(muted: boolean): void {
  useVideoPrefs.setState((s) => ({ muted, volume: !muted && s.volume === 0 ? 0.5 : s.volume }))
}

export function setLoop(loop: boolean): void {
  useVideoPrefs.setState({ loop })
}

export const SEEK_STEP_S = 5
export const VOLUME_STEP = 0.1
