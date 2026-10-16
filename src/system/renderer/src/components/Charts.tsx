import { useId, type ReactNode } from "react"
import { HISTORY } from "../features/system"

// The dashboard's charts: SVG drawn here, colored with the theme's tokens
// (ADR-0042: no chart library). Values ease to the next sample (styles.css,
// .chart-ease); nothing moves under prefers-reduced-motion.

/** The color of a share that fills up: the accent, then a warning, then danger. */
export function fillTone(fraction: number): string {
  if (fraction >= 0.9) return "var(--danger)"
  if (fraction >= 0.75) return "var(--warning)"
  return "var(--accent)"
}

const clamp = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))

/** A gauge: a ring filled to `value` (0..1), with the value or a label in its middle. */
export function Ring({
  value,
  size = 112,
  stroke = 10,
  color = fillTone(value),
  children,
  label,
}: {
  value: number
  size?: number
  stroke?: number
  color?: string
  /** What the middle shows (the percentage, usually). */
  children: ReactNode
  /** The ring's name for assistive technology. */
  label: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamp(value) * 100)}
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="color-mix(in srgb, var(--text) 10%, transparent)"
          strokeWidth={stroke}
        />
        <circle
          className="chart-ease"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamp(value))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ filter: `drop-shadow(0 0 6px color-mix(in srgb, ${color} 45%, transparent))` }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  )
}

/**
 * The last minute as an area chart: `values` (0..1, oldest first) fill from
 * the right, so the newest second is always at the right edge.
 */
export function Sparkline({
  values,
  color = "var(--accent)",
  height = 56,
  label,
}: {
  values: readonly number[]
  color?: string
  height?: number
  label: string
}) {
  const id = useId()
  const width = 240
  const step = width / (HISTORY - 1)
  const start = HISTORY - values.length
  const points = values.map((v, i) => [(start + i) * step, height - clamp(v) * (height - 4) - 2])
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x!.toFixed(1)} ${y!.toFixed(1)}`)
  const area =
    points.length > 1
      ? `${line.join(" ")} L${width} ${height} L${points[0]![0]!.toFixed(1)} ${height} Z`
      : ""
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block h-14 w-full"
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Quarter lines: 25, 50 and 75%. */}
      {[0.25, 0.5, 0.75].map((q) => (
        <line
          key={q}
          x1="0"
          x2={width}
          y1={height - q * (height - 4) - 2}
          y2={height - q * (height - 4) - 2}
          stroke="color-mix(in srgb, var(--text) 7%, transparent)"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {area && <path d={area} fill={`url(#${id})`} />}
      {points.length > 1 && (
        <path
          d={line.join(" ")}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  )
}

/** One bar per logical processor, its height the processor's load. */
export function CoreBars({ cores, label }: { cores: readonly number[]; label: string }) {
  return (
    <div role="img" aria-label={label} className="flex h-12 items-end gap-[3px]">
      {cores.map((load, i) => (
        <div
          key={i}
          className="relative h-full min-w-[3px] flex-1 overflow-hidden rounded-sm"
          style={{ background: "color-mix(in srgb, var(--text) 8%, transparent)" }}
        >
          <div
            className="chart-ease absolute inset-x-0 bottom-0 rounded-sm"
            style={{ height: `${clamp(load) * 100}%`, background: fillTone(load) }}
          />
        </div>
      ))}
    </div>
  )
}

/** A capacity bar: how full a volume is, in the color of how full. */
export function Meter({ value, label }: { value: number; label: string }) {
  const v = clamp(value)
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className="h-2 w-full overflow-hidden rounded-full"
      style={{ background: "color-mix(in srgb, var(--text) 9%, transparent)" }}
    >
      <div
        className="chart-ease h-full rounded-full"
        style={{
          width: `${v * 100}%`,
          background: `linear-gradient(90deg, color-mix(in srgb, ${fillTone(v)} 70%, transparent), ${fillTone(v)})`,
        }}
      />
    </div>
  )
}
