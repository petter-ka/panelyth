import { forwardRef, useImperativeHandle, useRef, useState } from "react"
import { openPath, toPanelError, useListingStore } from "../features/listing"
import type { Side } from "../features/panels"

export interface PathBarHandle {
  edit(): void
}

interface PathBarProps {
  side: Side
  active: boolean
  /** Called after editing ends, so focus returns to the list. */
  onDone(): void
}

/** The current path; a click or Alt+D edits it, Enter navigates, Esc cancels (UX-DESIGN "Path bar"). */
export const PathBar = forwardRef<PathBarHandle, PathBarProps>(function PathBar(
  { side, active, onDone },
  ref,
) {
  const path = useListingStore((s) => s[side].path)
  const loading = useListingStore((s) => s[side].loading)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const edit = (): void => {
    setValue(path)
    setError(null)
    setEditing(true)
    queueMicrotask(() => input.current?.select())
  }
  useImperativeHandle(ref, () => ({ edit }))

  const stop = (): void => {
    setEditing(false)
    setError(null)
    onDone()
  }

  const submit = async (): Promise<void> => {
    const target = value.trim()
    if (target === "" || target === path) return stop()
    try {
      await openPath(side, target, { inline: true })
      stop()
    } catch (e) {
      setError(toPanelError(e).message)
    }
  }

  return (
    <div className="relative flex h-8 shrink-0 items-center border-b border-border bg-chrome px-2 text-xs">
      {editing ? (
        <input
          ref={input}
          aria-label="Path"
          aria-invalid={error !== null}
          aria-describedby={error ? `${side}-path-error` : undefined}
          value={value}
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") void submit()
            else if (e.key === "Escape") stop()
          }}
          onBlur={() => {
            if (!error) setEditing(false)
          }}
          className="h-6 w-full rounded border border-accent bg-canvas px-1.5 font-mono font-normal text-text outline-none"
        />
      ) : (
        <button
          type="button"
          tabIndex={-1}
          title="Edit the path (Alt+D)"
          onClick={edit}
          data-testid={`path-${side}`}
          aria-busy={loading}
          className={`h-6 w-full truncate rounded px-1.5 text-left font-mono font-normal hover:bg-raised ${active ? "text-text" : "text-muted"}`}
        >
          {path || "No folder open"}
        </button>
      )}
      {editing && error && (
        <p
          id={`${side}-path-error`}
          role="alert"
          className="absolute top-full right-2 left-2 z-10 rounded-b border border-t-0 border-border bg-raised px-2 py-1 text-danger shadow"
        >
          {error}
        </p>
      )}
    </div>
  )
})
