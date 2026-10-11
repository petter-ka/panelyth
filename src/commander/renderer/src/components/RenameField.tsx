import { useEffect, useRef, useState } from "react"
import { cancelRename, commitRename, useFilesStore } from "../features/files"
import type { Side } from "../features/panels"
import { t } from "@panelyth/i18n"

/** Is this view row being renamed? (Rows subscribe to this boolean only.) */
export const useRenaming = (side: Side, row: number): boolean =>
  useFilesStore((s) => s.rename !== null && s.rename.side === side && s.rename.row === row)

/**
 * F2 / Shift+F6 (Stage C04, CFR-12): the inline editor on the cursor row.
 * The name is selected without its extension; Enter renames (Go validates
 * the name), Esc or leaving the field cancels. Keys never reach the panel.
 */
export function RenameField({ onDone }: { onDone(): void }) {
  const r = useFilesStore((s) => s.rename)
  const [value, setValue] = useState(r?.name ?? "")
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = input.current
    if (!el || !r) return
    el.focus()
    const dot = r.isDir ? -1 : r.name.lastIndexOf(".")
    el.setSelectionRange(0, dot > 0 ? dot : r.name.length)
    // Only when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!r) return null
  return (
    <span className="relative flex min-w-0 flex-1 items-center">
      <input
        ref={input}
        aria-label={t("New name")}
        aria-invalid={r.error !== null}
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
          if (useFilesStore.getState().rename?.error === null) cancelRename()
        }}
        className="h-[calc(100%-2px)] w-full rounded-sm border border-accent bg-canvas px-1 text-text outline-none"
      />
      {r.error && (
        <span
          role="alert"
          className="absolute top-full left-0 z-10 mt-0.5 rounded border border-border bg-raised px-2 py-1 text-danger shadow"
        >
          {r.error}
        </span>
      )}
    </span>
  )
}
