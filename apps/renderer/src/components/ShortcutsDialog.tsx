import { useState, type KeyboardEvent } from "react"
import {
  ACTIONS,
  defaultChords,
  eventChord,
  formatChord,
  type ActionDef,
  type ActionId,
} from "../features/shortcuts/keymap"
import {
  resetAllBindings,
  resetBinding,
  setBinding,
  setShortcutHelpOpen,
  useShortcutStore,
} from "../features/shortcuts/shortcutStore"
import { Button, Kbd } from "./ui/button"
import { DialogWindow } from "./ui/dialog"

const GROUPS = [...new Set(ACTIONS.map((a) => a.group))]

/**
 * Keyboard shortcut reference and the first customization surface
 * (Stage 08, ADR-0022): "Change" records the next key chord for an action;
 * a chord already used in the same scope moves to the new action.
 */
export function ShortcutsDialog() {
  const open = useShortcutStore((s) => s.helpOpen)
  const chords = useShortcutStore((s) => s.keymap.chords)
  const overrides = useShortcutStore((s) => s.overrides.bindings)
  const [recording, setRecording] = useState<ActionId | null>(null)

  const onRecordKey = (e: KeyboardEvent<HTMLButtonElement>, id: ActionId): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === "Escape") return // handled by the dialog's onEscapeKeyDown
    const chord = eventChord(e.nativeEvent)
    if (!chord) return // a bare modifier: keep listening
    setBinding(id, [chord])
    setRecording(null)
  }

  return (
    <DialogWindow
      open={open}
      onOpenChange={(o) => {
        setRecording(null)
        setShortcutHelpOpen(o)
      }}
      title="Keyboard shortcuts"
      onEscapeKeyDown={(e) => {
        if (!recording) return
        e.preventDefault() // Esc cancels the recording, not the dialog
        setRecording(null)
      }}
    >
      <div className="-mx-4 -mt-4 max-h-[60vh] overflow-y-auto px-4 pt-2" data-testid="shortcuts">
        {GROUPS.map((group) => (
          <section key={group} aria-label={group} className="pt-2">
            <h3 className="pb-1 text-[0.6875rem] font-medium text-muted">{group}</h3>
            <ul>
              {ACTIONS.filter((a) => a.group === group).map((a: ActionDef) => {
                const id = a.id as ActionId
                const custom = overrides[id] !== undefined
                return (
                  <li key={id} className="flex h-8 items-center gap-2 text-xs" data-action={id}>
                    <span className="min-w-0 flex-1 truncate">
                      {a.label}
                      {custom && (
                        <span className="pl-1.5 text-[0.6875rem] text-muted">(custom)</span>
                      )}
                    </span>
                    {recording === id ? (
                      <button
                        type="button"
                        autoFocus
                        onKeyDown={(e) => onRecordKey(e, id)}
                        onBlur={() => setRecording(null)}
                        className="h-6 rounded border border-accent px-2 text-[0.6875rem] text-accent"
                      >
                        Press keys… (Esc cancels)
                      </button>
                    ) : (
                      <span className="flex gap-1">
                        {chords[id].length > 0 ? (
                          chords[id].map((c) => <Kbd key={c}>{formatChord(c)}</Kbd>)
                        ) : (
                          <span className="text-[0.6875rem] text-muted">Not set</span>
                        )}
                      </span>
                    )}
                    <Button
                      size="sm"
                      className="h-6 px-2"
                      aria-label={`Change shortcut for ${a.label}`}
                      onClick={() => setRecording(id)}
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
                      onClick={() => resetBinding(id)}
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
        <Button disabled={Object.keys(overrides).length === 0} onClick={resetAllBindings}>
          Reset all
        </Button>
      </div>
    </DialogWindow>
  )
}
