// The histogram of the rendered frame (Stage 12). Go counts the bins in the
// render pass; this only draws them, at most once per frame.
import { useEffect, useRef, useState } from "react"
import type { EditHistogram } from "@panelyth/contracts"
import { Tooltip } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import { formatPercent } from "../../lib/format"
import { useEditorStore } from "../../features/editor/editorStore"
import { Segmented } from "./controls"

type Channel = "lum" | "rgb" | "r" | "g" | "b"

const W = 256
const H = 64

const COLORS: Record<"lum" | "r" | "g" | "b", string> = {
  lum: "rgba(200, 200, 200, 0.9)",
  r: "rgba(235, 80, 80, 0.75)",
  g: "rgba(80, 200, 110, 0.75)",
  b: "rgba(90, 140, 245, 0.75)",
}

function draw(
  ctx: CanvasRenderingContext2D,
  h: EditHistogram,
  channel: Channel,
  log: boolean,
): void {
  ctx.clearRect(0, 0, W, H)
  const series: ("lum" | "r" | "g" | "b")[] = channel === "rgb" ? ["r", "g", "b"] : [channel]
  const scale = (v: number): number => (log ? Math.log1p(v) : v)
  // The ends hold the clipped pixels and would flatten everything else.
  let peak = 1
  for (const key of series) {
    const bins = h[key]
    for (let i = 1; i < 255; i++) peak = Math.max(peak, scale(bins[i]!))
  }
  ctx.globalCompositeOperation = series.length > 1 ? "lighter" : "source-over"
  for (const key of series) {
    const bins = h[key]
    ctx.fillStyle = COLORS[key]
    for (let i = 0; i < 256; i++) {
      const bar = Math.min(1, scale(bins[i]!) / peak) * H
      if (bar > 0) ctx.fillRect(i, H - bar, 1, bar)
    }
  }
  ctx.globalCompositeOperation = "source-over"
}

/** The share of pixels as a percentage for the clipping badges. */
function share(count: number, pixels: number): number {
  return pixels > 0 ? count / pixels : 0
}

export function Histogram() {
  const histogram = useEditorStore((s) => s.histogram)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [channel, setChannel] = useState<Channel>("lum")
  const [log, setLog] = useState(false)

  useEffect(() => {
    const ctx = canvas.current?.getContext?.("2d")
    if (!ctx) return
    if (histogram) draw(ctx, histogram, channel, log)
    else ctx.clearRect(0, 0, W, H)
  }, [histogram, channel, log])

  const low = histogram ? share(histogram.clipLow, histogram.pixels) : 0
  const high = histogram ? share(histogram.clipHigh, histogram.pixels) : 0
  const summary = histogram
    ? t(
        "Histogram: mean brightness {mean} of 255; {low} clipped shadows, {high} clipped highlights",
        {
          mean: Math.round(histogram.mean),
          low: formatPercent(low),
          high: formatPercent(high),
        },
      )
    : t("Histogram")

  return (
    <section
      aria-label={t("Histogram")}
      className="space-y-1.5 border-b border-border px-3 py-2.5"
      data-testid="editor-histogram"
    >
      <div className="relative">
        <canvas
          ref={canvas}
          width={W}
          height={H}
          role="img"
          aria-label={summary}
          className="block h-16 w-full rounded bg-canvas"
        />
        {/* Clipping badges: shown from 0.1 % of the picture. */}
        {low >= 0.001 && (
          <Tooltip content={t("Clipped shadows")}>
            <span
              data-testid="clip-low"
              className="absolute top-1 left-1 rounded bg-black/60 px-1 text-[0.625rem] text-white tabular-nums"
            >
              ◣ {formatPercent(low)}
            </span>
          </Tooltip>
        )}
        {high >= 0.001 && (
          <Tooltip content={t("Clipped highlights")}>
            <span
              data-testid="clip-high"
              className="absolute top-1 right-1 rounded bg-black/60 px-1 text-[0.625rem] text-white tabular-nums"
            >
              {formatPercent(high)} ◥
            </span>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Segmented<Channel>
            label={t("Histogram channel")}
            value={channel}
            options={[
              { value: "lum", label: "L", title: t("Luminosity") },
              { value: "rgb", label: "RGB", title: t("Red, green and blue") },
              { value: "r", label: "R", title: t("Red") },
              { value: "g", label: "G", title: t("Green") },
              { value: "b", label: "B", title: t("Blue") },
            ]}
            onChange={setChannel}
          />
        </div>
        <Tooltip content={t("Logarithmic scale")}>
          <button
            type="button"
            aria-pressed={log}
            onClick={() => setLog(!log)}
            aria-label={t("Logarithmic scale")}
            className="h-7 rounded-md border border-border px-1.5 text-[0.6875rem] text-muted hover:text-text aria-pressed:border-accent aria-pressed:text-accent"
          >
            log
          </button>
        </Tooltip>
      </div>
    </section>
  )
}
