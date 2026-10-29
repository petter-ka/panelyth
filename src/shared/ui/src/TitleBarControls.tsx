import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"
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

export interface TitleBarGridOption<T extends string> {
  value: T
  /** The option's name, large in its tile. */
  name: string
  /** What it does, one line under the name. */
  description?: string | undefined
  /** The small drawing on the strip's button while this option is chosen. */
  icon: ReactNode
  /** The large drawing in the option's tile. */
  largeIcon: ReactNode
}

/** How long the pointer may be off the button and the menu before the menu closes. */
const HOVER_CLOSE_MS = 220

/**
 * One button for many choices (the commander's layout presets, owner request
 * 2026-10-27): it shows the chosen one's drawing, and pointing at it (or a
 * click, Enter or the down arrow) opens a menu with every choice as a large
 * tile. While it is open the arrows move between the tiles; when it closes
 * (a choice, Esc, or the pointer gone from both the button and the menu, if
 * pointing opened it) the keys go back where they were: the panel cursor.
 */
export function TitleBarGridMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  columns = 4,
  testId,
  onFocusLost,
}: {
  label: string
  /** The chosen option; "" when none matches. */
  value: T | ""
  options: readonly TitleBarGridOption<T>[]
  onChange(value: T): void
  columns?: number
  testId?: string
  /**
   * The element that had the keys is gone once the menu closes (the choice
   * rebuilt it): the caller puts them somewhere sensible.
   */
  onFocusLost?: () => void
}) {
  const [open, setOpen] = useState(false)
  const byPointer = useRef(false)
  const restore = useRef<HTMLElement | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chosen = options.find((o) => o.value === value)

  const stay = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const show = (pointer: boolean): void => {
    stay()
    if (open) return
    byPointer.current = pointer
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen(true)
  }
  const leave = (): void => {
    if (!byPointer.current) return
    stay()
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS)
  }
  useEffect(() => stay, [])

  return (
    <DropdownMenu.Root
      open={open}
      modal={false}
      onOpenChange={(next) => (next ? show(false) : setOpen(false))}
    >
      {/* No tooltip: pointing opens the menu, which names itself. */}
      <DropdownMenu.Trigger
        aria-label={label}
        aria-description={chosen?.name}
        data-testid={testId}
        onMouseDown={keepFocus}
        onPointerEnter={(e) => e.pointerType === "mouse" && show(true)}
        onPointerLeave={leave}
        // Opened by pointing, a press keeps it open (Radix would close it).
        onPointerDown={(e) => {
          if (open) e.preventDefault()
        }}
        className={`flex h-[26px] items-center gap-1 rounded-md border border-border px-1.5 text-muted hover:text-text data-[state=open]:bg-raised data-[state=open]:text-text ${focusRing}`}
      >
        <span className={chosen ? "text-accent" : ""}>{chosen?.icon ?? options[0]?.icon}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path
            d="M2.5 4l2.5 2.5L7.5 4"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          data-testid={testId ? `${testId}-menu` : undefined}
          onPointerEnter={stay}
          onPointerLeave={leave}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            const back = restore.current
            if (back?.isConnected) back.focus({ preventScroll: true })
            else onFocusLost?.()
          }}
          className="glass-float motion-pop z-50 rounded-lg border border-border bg-raised p-2 text-text shadow-xl shadow-black/30 outline-none"
        >
          <div className="px-1.5 pt-0.5 pb-2 text-2xs font-medium text-muted">{label}</div>
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(v) => onChange(v as T)}
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {options.map((o) => (
              <DropdownMenu.RadioItem
                key={o.value}
                value={o.value}
                aria-label={o.description ? `${o.name}, ${o.description}` : o.name}
                className="group flex w-32 cursor-default flex-col items-center gap-1.5 rounded-md border border-transparent px-2 pt-3 pb-2.5 text-center outline-none select-none data-[highlighted]:border-border data-[highlighted]:bg-canvas data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent/10"
              >
                <span className="text-muted group-data-[highlighted]:text-text group-data-[state=checked]:text-accent">
                  {o.largeIcon}
                </span>
                <span className="text-xs font-medium">{o.name}</span>
                {o.description && (
                  <span className="text-2xs leading-snug text-muted">{o.description}</span>
                )}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
