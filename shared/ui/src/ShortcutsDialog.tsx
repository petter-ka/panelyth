import { defaultChords, eventChord, formatChord, type ActionDef } from "@fastview/renderer-core"
import { useState, type KeyboardEvent } from "react"
import { Button, Kbd } from "./button"
import { DialogWindow } from "./dialog"

export interface ShortcutsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** The app's registry, in display order (grouped by `group`). */
  actions: readonly ActionDef[]
  /** Effective chords per action id. */
  chords: Readonly<Record<string, readonly string[]>>
  /** Action ids with a custom binding. */
  customized: ReadonlySet<string>
  onSet(id: string, chords: string[]): void
  onReset(id: string): void
  onResetAll(): void
}

/**
 * The keyboard shortcut reference and editor of both apps (ADR-0022,
 * ADR-0031): "Change" records the next key chord for an action; a chord
 * already used in the same scope moves to the new action.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  actions,
  chords,
  customized,
  onSet,
  onReset,
  onResetAll,
}: ShortcutsDialogProps) {
  const [recording, setRecording] = useState<string | null>(null)

  const onRecordKey = (e: KeyboardEvent<HTMLButtonElement>, id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === "Escape") return // handled by the dialog's onEscapeKeyDown
    const chord = eventChord(e.nativeEvent)
    if (!chord) return // a bare modifier: keep listening
    onSet(id, [chord])
    setRecording(null)
  }

  return (
    <DialogWindow
      open={open}
      onOpenChange={(o) => {
        setRecording(null)
        onOpenChange(o)
      }}
      title="Keyboard shortcuts"
      onEscapeKeyDown={(e) => {
        if (!recording) return
        e.preventDefault() // Esc cancels the recording, not the dialog
        setRecording(null)
      }}
    >
      <div className="-mx-4 -mt-4 max-h-[60vh] overflow-y-auto px-4 pt-2" data-testid="shortcuts">
        {[...new Set(actions.map((a) => a.group))].map((group) => (
          <section key={group} aria-label={group} className="pt-2">
            <h3 className="pb-1 text-[0.6875rem] font-medium text-muted">{group}</h3>
            <ul>
              {actions
                .filter((a) => a.group === group)
                .map((a) => {
                  const custom = customized.has(a.id)
                  const own = chords[a.id] ?? []
                  return (
                    <li
                      key={a.id}
                      className="flex h-8 items-center gap-2 text-xs"
                      data-action={a.id}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {a.label}
                        {custom && (
                          <span className="pl-1.5 text-[0.6875rem] text-muted">(custom)</span>
                        )}
                      </span>
                      {recording === a.id ? (
                        <button
                          type="button"
                          autoFocus
                          onKeyDown={(e) => onRecordKey(e, a.id)}
                          onBlur={() => setRecording(null)}
                          className="h-6 rounded border border-accent px-2 text-[0.6875rem] text-accent"
                        >
                          Press keys… (Esc cancels)
                        </button>
                      ) : (
                        <span className="flex gap-1">
                          {own.length > 0 ? (
                            own.map((c) => <Kbd key={c}>{formatChord(c)}</Kbd>)
                          ) : (
                            <span className="text-[0.6875rem] text-muted">Not set</span>
                          )}
                        </span>
                      )}
                      <Button
                        size="sm"
                        className="h-6 px-2"
                        aria-label={`Change shortcut for ${a.label}`}
                        onClick={() => setRecording(a.id)}
                      >
                        Change
                      </Button>
                      <Button
                        size="sm"
                        className="h-6 px-2"
                        disabled={!custom}
                        aria-label={`Reset shortcut for ${a.label}`}
                        title={`Default: ${
                          defaultChords(a)
                            .map((c) => formatChord(c))
                            .join(", ") || "none"
                        }`}
                        onClick={() => onReset(a.id)}
                      >
                        Reset
                      </Button>
                    </li>
                  )
                })}
            </ul>
          </section>
        ))}
      </div>
      <div className="flex justify-end border-t border-border pt-3">
        <Button disabled={customized.size === 0} onClick={onResetAll}>
          Reset all
        </Button>
      </div>
    </DialogWindow>
  )
}
