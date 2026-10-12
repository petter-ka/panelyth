// The editor's controls (Stage 12, DESIGN-SYSTEM "Editor controls"): a
// slider is a track, a number field and a reset dot, and every one of them
// has a keyboard route. Built on native inputs, so focus, arrow keys and
// screen readers work as everywhere else.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react"
import { fieldLook, Tooltip } from "@panelyth/ui"
import { t } from "@panelyth/i18n"

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/** Reads "12", "12.5", "12,5", "50 %", "3°" or "200 px"; null for anything else. */
export function parseNumber(text: string): number | null {
  const m = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:%|°|px|dpi|cm|in)?\s*$/.exec(text)
  if (!m) return null
  const v = Number(m[1]!.replace(",", "."))
  return Number.isFinite(v) ? v : null
}

function format(value: number, step: number): string {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return String(Number(value.toFixed(digits)))
}

interface NumberFieldProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  disabled?: boolean
  /** A committed value (Enter, blur, arrow keys). */
  onChange(value: number): void
  className?: string
  /** Labelled by the visible text of a surrounding control. */
  hideLabel?: boolean
}

/**
 * A number with its unit. Typing is free; the value is taken on Enter or
 * blur. Arrow keys step by one, with Shift by ten.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  disabled,
  onChange,
  className,
  hideLabel,
}: NumberFieldProps) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? format(value, step)
  const take = (text: string): void => {
    setDraft(null)
    const parsed = parseNumber(text)
    if (parsed !== null && parsed !== value) onChange(clamp(parsed, min, max))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      take(e.currentTarget.value)
      e.preventDefault()
    } else if (e.key === "Escape" && draft !== null) {
      setDraft(null)
      e.preventDefault()
      e.stopPropagation()
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const base = parseNumber(e.currentTarget.value) ?? value
      const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
      setDraft(null)
      onChange(clamp(Number((base + delta).toFixed(4)), min, max))
      e.preventDefault()
    }
  }
  return (
    <label
      htmlFor={id}
      className={`flex items-center gap-1 text-2xs text-muted ${className ?? ""}`}
    >
      {!hideLabel && <span className="min-w-0 flex-1 truncate">{label}</span>}
      <span className="flex h-7 items-center rounded-md border border-muted/70 bg-raised focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          aria-label={hideLabel ? label : undefined}
          aria-description={unit}
          disabled={disabled}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => draft !== null && take(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-14 bg-transparent px-1.5 text-right text-xs text-text tabular-nums outline-none disabled:opacity-50"
        />
        {unit && (
          <span className="pr-1.5 text-2xs text-muted" aria-hidden="true">
            {unit}
          </span>
        )}
      </span>
    </label>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  /** The value the reset dot and double click go back to. */
  defaultValue: number
  disabled?: boolean
  /** `live` is true while the thumb is dragged; the last change of a drag is followed by onCommit. */
  onChange(value: number, live: boolean): void
  onCommit?(): void
}

/**
 * Track, number and reset. Arrows step by one, Shift by ten, Home and End
 * jump (the native range input); double click or Ctrl/Cmd+0 resets.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  defaultValue,
  disabled,
  onChange,
  onCommit,
}: SliderProps) {
  const id = useId()
  const dragging = useRef(false)
  const commit = useRef(onCommit)
  useEffect(() => {
    commit.current = onCommit
  })
  const end = (): void => {
    if (!dragging.current) return
    dragging.current = false
    commit.current?.()
  }
  // A slider that goes away mid-drag (its panel closed) still ends the drag.
  useEffect(
    () => () => {
      if (dragging.current) commit.current?.()
    },
    [],
  )
  const reset = (): void => {
    if (value !== defaultValue) onChange(defaultValue, false)
  }
  return (
    <div className="space-y-1" data-slider={label}>
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="min-w-0 flex-1 truncate text-2xs text-muted">
          {label}
        </label>
        <NumberField
          label={label}
          hideLabel
          value={value}
          min={min}
          max={max}
          step={step}
          {...(unit !== undefined && { unit })}
          {...(disabled !== undefined && { disabled })}
          onChange={(v) => onChange(v, false)}
        />
        <Tooltip content={t("Reset")}>
          <button
            type="button"
            aria-label={t("Reset {name}", { name: label })}
            disabled={disabled || value === defaultValue}
            onClick={reset}
            className="grid size-5 place-items-center rounded-full text-muted hover:text-text disabled:opacity-30"
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={`${format(value, step)}${unit ? ` ${unit}` : ""}`}
        onPointerDown={() => {
          dragging.current = true
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onBlur={end}
        onChange={(e) => onChange(Number(e.target.value), dragging.current)}
        onDoubleClick={reset}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "0") {
            reset()
            e.preventDefault()
            e.stopPropagation()
          }
        }}
        className="editor-range block h-4 w-full"
      />
    </div>
  )
}

/** A row of exclusive choices (a segmented control). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string; title?: string }[]
  onChange(value: T): void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-md bg-canvas p-0.5">
      {options.map((o) => (
        <Tooltip key={o.value} content={o.title}>
          <button
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.title ?? o.label}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className="h-6 min-w-0 flex-1 truncate rounded px-1.5 text-2xs text-muted hover:text-text aria-checked:bg-raised aria-checked:text-text aria-checked:shadow-sm disabled:opacity-50"
          >
            {o.label}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange(value: T): void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-2xs text-muted">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className={`h-7 max-w-[60%] px-1.5 text-xs disabled:opacity-50 ${fieldLook}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Check({
  label,
  checked,
  onChange,
  disabled,
  description,
}: {
  label: string
  checked: boolean
  onChange(value: boolean): void
  disabled?: boolean
  description?: string
}) {
  return (
    <label className="flex items-start gap-2 text-2xs text-text">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 accent-[var(--color-accent)]"
      />
      <span className="min-w-0">
        {label}
        {description && <span className="block text-muted">{description}</span>}
      </span>
    </label>
  )
}

const HEX = /^#[0-9a-f]{6}$/i

/** A fill: a color, or one of the named fills a tool offers (transparent, edge). */
export function FillField({
  label,
  value,
  named,
  onChange,
}: {
  label: string
  value: string
  named: readonly { value: string; label: string }[]
  onChange(value: string): void
}) {
  const isColor = HEX.test(value)
  const choice = isColor ? "color" : value
  return (
    <div className="space-y-1.5">
      <Segmented
        label={label}
        value={choice}
        options={[{ value: "color", label: t("Color") }, ...named]}
        onChange={(v) => onChange(v === "color" ? "#ffffff" : v)}
      />
      {isColor && (
        <label className="flex items-center gap-2 text-2xs text-muted">
          <span className="min-w-0 flex-1 truncate">{t("Fill color")}</span>
          <input
            type="color"
            value={value}
            aria-label={t("Fill color")}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 w-10 rounded border border-border bg-canvas"
          />
        </label>
      )}
    </div>
  )
}

export function PanelSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border px-3 py-2.5 last:border-b-0">
      {title && <h3 className="text-2xs font-medium text-muted">{title}</h3>}
      {children}
    </section>
  )
}

/** Ends a drag wherever the pointer is released. */
export function capturePointer(e: PointerEvent<Element>): void {
  // jsdom has no pointer capture.
  e.currentTarget.setPointerCapture?.(e.pointerId)
}
