import {
  MAX_PROGRAMS,
  MAX_PROGRAM_NAME_CHARS,
  type ExternalProgram,
  type ProgramTarget,
} from "@panelyth/contracts"
import { PanelythError, addProgram, updatePrograms, usePrograms } from "@panelyth/renderer-core"
import { msg, t } from "@panelyth/i18n"
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Button } from "./button"
import { fieldClass, fieldLook } from "./field"
import { TrashIcon } from "./icons"

const TARGETS: readonly { value: ProgramTarget; label: string }[] = [
  { value: "files", label: msg("Files") },
  { value: "folders", label: msg("Folders") },
  { value: "both", label: msg("Files and folders") },
]

/** What a refused "Open with" call says to the user (ADR-0044); `name` is the program's. */
export function programRefusal(error: unknown, name = ""): string {
  if (error instanceof PanelythError) {
    if (error.code === "NOT_FOUND") return t("This program is no longer in Settings.")
    switch ((error.details as { reason?: unknown } | undefined)?.reason) {
      case "missing":
        return t("{name} was not found. Add it again in Settings → Open with.", { name })
      case "target":
      case "kind":
        return t("{name} doesn't open this kind of item.", { name })
      case "program":
        return t("This file can't be started as a program.")
      case "full":
        return t("You can add up to {count} programs.", { count: MAX_PROGRAMS })
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/** Settings → Open with (both apps): the programs the context menus offer. */
export function ProgramsSettings({ app }: { app: "viewer" | "commander" }) {
  const programs = usePrograms((s) => s.programs)
  const [error, setError] = useState<string | null>(null)

  const run = (work: Promise<unknown>): void => {
    setError(null)
    work.catch((e: unknown) => setError(programRefusal(e)))
  }
  // The list as it is now: a name saved after a pause must not undo a change made since.
  const change = (id: string, patch: Partial<ExternalProgram>): void =>
    run(
      updatePrograms(
        usePrograms.getState().programs.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      ),
    )
  const move = (index: number, by: -1 | 1): void => {
    const next = [...programs]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(index + by, 0, moved)
    run(updatePrograms(next))
  }

  return (
    <section aria-label={t("Open with")} className="space-y-3" data-testid="settings-programs">
      <p className="text-2xs text-muted">
        {app === "viewer"
          ? t(
              "Programs listed in the context menu. Each opens the item you right-click: a folder, a picture or a video.",
            )
          : t(
              "Programs listed in the context menu of files and folders. Each opens the item you right-click.",
            )}
      </p>
      {programs.length === 0 ? (
        <p className="text-xs text-muted">{t("No programs yet.")}</p>
      ) : (
        <ul className="space-y-2">
          {programs.map((program, index) => (
            <li
              key={program.id}
              className="space-y-1 rounded-md border border-border p-2"
              data-testid="program-row"
            >
              <div className="flex items-center gap-1.5">
                <NameField name={program.name} onCommit={(name) => change(program.id, { name })} />
                <select
                  aria-label={t("Show for {name}", { name: program.name })}
                  value={program.target}
                  onChange={(e) => change(program.id, { target: e.target.value as ProgramTarget })}
                  className={`h-8 w-36 shrink-0 px-1.5 text-xs ${fieldLook}`}
                >
                  {TARGETS.map((target) => (
                    <option key={target.value} value={target.value}>
                      {t(target.label)}
                    </option>
                  ))}
                </select>
                <Button
                  size="icon"
                  aria-label={t("Move up")}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="icon"
                  aria-label={t("Move down")}
                  disabled={index === programs.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="icon"
                  aria-label={t("Remove {name}", { name: program.name })}
                  title={t("Remove")}
                  onClick={() => run(updatePrograms(programs.filter((_, i) => i !== index)))}
                >
                  <TrashIcon />
                </Button>
              </div>
              <p className="truncate text-2xs text-muted" title={program.path}>
                {program.path}
              </p>
            </li>
          ))}
        </ul>
      )}
      <Button
        size="sm"
        disabled={programs.length >= MAX_PROGRAMS}
        onClick={() => run(addProgram())}
        data-testid="add-program"
      >
        {t("Add program…")}
      </Button>
      {error && (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

/** A pause in typing after which the name is saved. */
const SAVE_AFTER_MS = 400

/**
 * The name as the menu shows it. It is saved as it is typed (after a pause),
 * and at once on Enter, Esc, leaving the field or closing Settings: like every
 * setting, a change applies without a Save button (ADR-0039).
 */
function NameField({ name, onCommit }: { name: string; onCommit(name: string): void }) {
  const [value, setValue] = useState(name)
  // What is typed and not saved yet; read by the timer and on close.
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ name, onCommit })
  useEffect(() => {
    latest.current = { name, onCommit }
  })

  const flush = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const next = pending.current?.trim()
    pending.current = null
    if (next && next !== latest.current.name) latest.current.onCommit(next)
  }, [])

  // Settings may close (Esc, the window's close button) before a blur comes.
  useEffect(() => {
    window.addEventListener("pagehide", flush)
    return () => {
      window.removeEventListener("pagehide", flush)
      flush()
    }
  }, [flush])
  // A name changed elsewhere (the other app) shows, unless one is being typed.
  useEffect(() => {
    if (pending.current === null) setValue(name)
  }, [name])

  const onChange = (next: string): void => {
    setValue(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_AFTER_MS)
  }
  const onBlur = (): void => {
    flush()
    // An empty name is not saved: the field shows the name again.
    if (value.trim() === "") setValue(latest.current.name)
  }
  // Enter saves; Esc saves too, and then closes Settings as usual.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" || e.key === "Escape") flush()
  }
  return (
    <input
      aria-label={t("Program name")}
      value={value}
      maxLength={MAX_PROGRAM_NAME_CHARS}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      className={`${fieldClass} min-w-0 flex-1`}
    />
  )
}
