import type { MouseEvent, ReactNode } from "react"
import { Tooltip } from "./Tooltip"

// View switchers in the title strip (ADR-0045), beside the window buttons.
// They never take the focus: the panel cursor or the tiles keep the keys.

const keepFocus = (e: MouseEvent): void => e.preventDefault()

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"

export interface TitleBarOption<T extends string> {
  value: T
  label: string
  icon: ReactNode
  /** The key that does the same, shown in the tooltip. */
  shortcut?: string | undefined
}

/** One of a few choices: a row of icons, the chosen one lit. */
export function TitleBarSegment<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string
  value: T
  options: readonly TitleBarOption<T>[]
  onChange(value: T): void
  testId?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className="flex h-[26px] items-center gap-px rounded-md border border-border p-px"
    >
      {options.map((o) => (
        <Tooltip
          key={o.value}
          side="bottom"
          content={o.shortcut ? `${o.label} (${o.shortcut})` : o.label}
        >
          <button
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.label}
            data-value={o.value}
            onMouseDown={keepFocus}
            onClick={() => onChange(o.value)}
            className={`grid h-[22px] w-7 place-items-center rounded-[5px] text-muted hover:text-text aria-checked:bg-raised aria-checked:text-accent ${focusRing}`}
          >
            {o.icon}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

/** On or off: one icon, lit while on. */
export function TitleBarToggle({
  label,
  pressed,
  onClick,
  icon,
  shortcut,
  testId,
}: {
  label: string
  pressed: boolean
  onClick(): void
  icon: ReactNode
  shortcut?: string | undefined
  testId?: string
}) {
  return (
    <Tooltip side="bottom" content={shortcut ? `${label} (${shortcut})` : label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        onMouseDown={keepFocus}
        onClick={onClick}
        className={`grid size-[26px] place-items-center rounded-md text-muted hover:bg-raised hover:text-text aria-pressed:bg-raised aria-pressed:text-accent ${focusRing}`}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/** A thin rule between groups of the strip's controls. */
export function TitleBarDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
}

/** Small line drawings for the switchers that have no icon of their own (16px). */
function Drawing({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Tile sizes: nine, four or one tile. */
export const TileGridIcon = ({ size }: { size: "small" | "medium" | "large" }) => (
  <Drawing>
    {size === "small" &&
      [2.5, 6.5, 10.5].flatMap((y) =>
        [2.5, 6.5, 10.5].map((x) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="3" height="3" rx=".75" />
        )),
      )}
    {size === "medium" &&
      [2.5, 8.75].flatMap((y) =>
        [2.5, 8.75].map((x) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="4.75" height="4.75" rx="1.25" />
        )),
      )}
    {size === "large" && <rect x="2.5" y="2.5" width="11" height="11" rx="2" />}
  </Drawing>
)
