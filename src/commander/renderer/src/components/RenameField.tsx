import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { cancelRename, commitRename, useFilesStore } from "../features/files"
import type { Side } from "../features/panels"
import { t } from "@panelyth/i18n"

/** Is this view row being renamed? (Rows subscribe to this boolean only.) */
export const useRenaming = (side: Side, row: number): boolean =>
  useFilesStore((s) => s.rename !== null && s.rename.side === side && s.rename.row === row)

/**
 * F2 / Shift+F6 (Stage C04, CFR-12): the inline editor on the cursor row.
 * The name is selected without its extension; Enter renames (Go validates
 * the name), Esc cancels, and leaving the field renames too (as in Explorer,
 * Finder and Total Commander). Keys never reach the panel.
 */
export function RenameField({ onDone }: { onDone(): void }) {
  const r = useFilesStore((s) => s.rename)
  const [value, setValue] = useState(r?.name ?? "")
  const input = useRef<HTMLInputElement>(null)
  const error = r?.error ?? null
  // Where the reason shows: below the field, outside the row (rows and cells clip).
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    const el = input.current
    if (!el || !r) return
    el.focus()
    const dot = r.isDir ? -1 : r.name.lastIndexOf(".")
    el.setSelectionRange(0, dot > 0 ? dot : r.name.length)
    // Only when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    const box = error ? input.current?.getBoundingClientRect() : undefined
    setAt(box ? { left: box.left, top: box.bottom + 2 } : null)
  }, [error])

  if (!r) return null
  return (
    <span className="relative flex min-w-0 flex-1 items-center">
      <input
        ref={input}
        aria-label={t("New name")}
        aria-invalid={error !== null}
        value={value}
        spellCheck={false}
        data-testid="rename-field"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter") {
            e.preventDefault()
            void commitRename(value).then((ok) => ok && onDone())
          } else if (e.key === "Escape") {
            e.preventDefault()
            cancelRename()
            onDone()
          }
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onBlur={() => {
          // Switching to another window keeps the edit; focus comes back to it.
          if (!document.hasFocus()) return
          void commitRename(value, true)
        }}
        className="h-[calc(100%-2px)] w-full rounded-sm border border-accent bg-canvas px-1 text-text outline-none aria-[invalid=true]:border-danger"
      />
      {error &&
        at &&
        createPortal(
          <span
            role="alert"
            className="glass-chip fixed z-50 max-w-[min(32rem,calc(100vw-2rem))] rounded border border-border bg-raised px-2 py-1 text-danger shadow"
            style={{ left: at.left, top: at.top }}
          >
            {error}
          </span>,
          document.body,
        )}
    </span>
  )
}
