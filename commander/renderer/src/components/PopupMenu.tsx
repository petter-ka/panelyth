import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react"

export interface MenuEntry {
  id: string
  label: ReactNode
  /** Right-aligned detail (free space, a path). */
  detail?: ReactNode
  /** A section heading; not selectable. */
  heading?: boolean
  /** A thin divider between sections. */
  separator?: boolean
  disabled?: boolean
  /** A key that selects the entry at once (a drive letter). */
  accessKey?: string
  /** The entry is the current one (pressed drive, current folder). */
  current?: boolean
  /** Render as a checked menu item. */
  checked?: boolean
  /** Keep the menu open after selecting (useful for multiple visibility toggles). */
  keepOpen?: boolean
  onSelect?: () => void
}

interface PopupMenuProps {
  label: string
  entries: readonly MenuEntry[]
  onClose(): void
  testId?: string
  /** Extra content under the entries ("Updating…"). */
  footer?: ReactNode
  className?: string
  style?: CSSProperties
}

const selectable = (e: MenuEntry | undefined): boolean =>
  !!e && !e.heading && !e.separator && !e.disabled

/**
 * A keyboard-first menu inside a panel (drive menu, hotlist, history, tab
 * menu): ↑/↓ move, Enter selects, an access key selects its entry, Esc or a
 * click elsewhere closes. Keys never reach the panel behind it.
 */
export function PopupMenu({
  label,
  entries,
  onClose,
  testId,
  footer,
  className,
  style,
}: PopupMenuProps) {
  const list = useRef<HTMLDivElement>(null)
  const firstSelectable = useMemo(() => {
    const current = entries.findIndex((e) => e.current && selectable(e))
    return current >= 0 ? current : entries.findIndex(selectable)
  }, [entries])
  const [focus, setFocus] = useState(firstSelectable)
  const shown = selectable(entries[focus]) ? focus : firstSelectable

  // Takes the keys while open and gives them back on close (the panel's
  // view, usually), so a key pressed right after Esc is never lost.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const menu = list.current
    menu?.focus()
    return () => {
      const now = document.activeElement
      if (before?.isConnected && (now === null || now === document.body || menu?.contains(now))) {
        before.focus()
      }
    }
  }, [])

  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent): void => {
      if (list.current && !list.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", onDown, true)
    return () => document.removeEventListener("mousedown", onDown, true)
  }, [onClose])

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${shown}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [shown])

  const step = (from: number, dir: 1 | -1): number => {
    for (let i = 1; i <= entries.length; i++) {
      const at = (from + dir * i + entries.length) % entries.length
      if (selectable(entries[at])) return at
    }
    return from
  }

  const choose = (index: number): void => {
    const entry = entries[index]
    if (!selectable(entry)) return
    if (!entry!.keepOpen) onClose()
    entry!.onSelect?.()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    e.stopPropagation()
    const key = e.key
    if (key === "ArrowDown" || key === "ArrowUp") {
      e.preventDefault()
      setFocus(step(shown, key === "ArrowDown" ? 1 : -1))
    } else if (key === "Home" || key === "End") {
      e.preventDefault()
      setFocus(key === "Home" ? step(-1 + entries.length, 1) : step(0, -1))
    } else if (key === "Enter" || key === " ") {
      e.preventDefault()
      choose(shown)
    } else if (key === "Escape" || key === "Tab") {
      e.preventDefault()
      onClose()
    } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const at = entries.findIndex(
        (x) => selectable(x) && x.accessKey?.toLowerCase() === key.toLowerCase(),
      )
      if (at >= 0) {
        e.preventDefault()
        choose(at)
      }
    }
  }

  return (
    <div
      ref={list}
      role="menu"
      aria-label={label}
      aria-activedescendant={shown >= 0 ? `${testId ?? "menu"}-item-${shown}` : undefined}
      tabIndex={-1}
      data-testid={testId}
      onKeyDown={onKeyDown}
      style={style}
      className={`absolute z-20 max-h-[min(28rem,80%)] min-w-64 overflow-y-auto rounded-md border border-border bg-raised py-1 text-xs shadow-xl shadow-black/30 outline-none ${className ?? "top-1 left-2"}`}
    >
      {entries.map((entry, index) =>
        entry.separator ? (
          <div key={entry.id} role="separator" className="my-1 border-t border-border" />
        ) : entry.heading ? (
          <div
            key={entry.id}
            role="presentation"
            className="px-3 pt-2 pb-1 text-[0.6875rem] font-semibold tracking-wide text-muted uppercase"
          >
            {entry.label}
          </div>
        ) : (
          <div
            key={entry.id}
            id={`${testId ?? "menu"}-item-${index}`}
            role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-disabled={entry.disabled || undefined}
            aria-current={entry.current || undefined}
            aria-checked={entry.checked}
            data-index={index}
            data-focused={index === shown}
            onMouseEnter={() => selectable(entry) && setFocus(index)}
            onClick={() => choose(index)}
            className={`flex h-7 cursor-default items-center gap-3 px-3 ${entry.disabled ? "text-muted" : "text-text"} data-[focused=true]:bg-accent/20`}
          >
            <span className="w-3 shrink-0 text-accent" aria-hidden="true">
              {entry.checked === true ? "✓" : entry.current ? "•" : ""}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.detail !== undefined && (
              <span className="shrink-0 text-[0.6875rem] text-muted tabular-nums">
                {entry.detail}
              </span>
            )}
          </div>
        ),
      )}
      {footer}
    </div>
  )
}
