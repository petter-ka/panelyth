import { MAX_COMMAND_CHARS } from "@panelyth/contracts"
import { formatChord } from "@panelyth/renderer-core"
import { Tooltip } from "@panelyth/ui"
import { useEffect, useRef, type KeyboardEvent } from "react"
import {
  clearCommandLine,
  closeCommandHistory,
  focusTaken,
  insertCursorText,
  openCommandHistory,
  pickHistory,
  runCommandLine,
  setCaretSource,
  setCommandText,
  useCommandLine,
} from "../features/cmdline"
import { useKeymapStore } from "../features/keymap"
import { useListingStore } from "../features/listing"
import { usePanelsStore } from "../features/panels"
import { focusPanel } from "../features/viewers"
import { PopupMenu, type MenuEntry } from "./PopupMenu"
import { t } from "@panelyth/i18n"

/**
 * The command line under the panels (Stage C10, CFR-24). The prompt shows the
 * active panel's folder. Enter runs the line there without a console window
 * (a program with a window shows it; what a console program prints is not
 * kept); Shift+Enter runs it in a console window that stays open. Nothing
 * else in the app runs a typed command.
 * Ctrl+Enter adds the cursor entry's name and Ctrl+Shift+Enter its full
 * path; Alt+F8 lists earlier commands; Esc clears.
 */
export function CommandLine() {
  const active = usePanelsStore((s) => s.active)
  const path = useListingStore((s) => s[active].path)
  const text = useCommandLine((s) => s.text)
  const message = useCommandLine((s) => s.message)
  const history = useCommandLine((s) => s.history)
  const historyOpen = useCommandLine((s) => s.historyOpen)
  const focusToken = useCommandLine((s) => s.focusToken)
  const chords = useKeymapStore((s) => s.keymap.chords)
  const input = useRef<HTMLInputElement>(null)
  /** Where the caret goes once the inserted text is rendered. */
  const caretAfter = useRef<number | null>(null)

  // Ctrl+K, a typed letter, a line from the history: the field takes the keys,
  // also when the request made the hidden command line appear.
  useEffect(() => {
    const el = input.current
    if (!el || !useCommandLine.getState().wantsFocus) return
    focusTaken()
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [focusToken])

  // An insert from the panel's keys lands at the caret while the field has the focus.
  useEffect(() => {
    setCaretSource(() => {
      const el = input.current
      if (!el || document.activeElement !== el) return null
      return {
        start: el.selectionStart ?? el.value.length,
        end: el.selectionEnd ?? el.value.length,
      }
    })
    return () => setCaretSource(null)
  }, [])

  useEffect(() => {
    if (caretAfter.current === null) return
    input.current?.setSelectionRange(caretAfter.current, caretAfter.current)
    caretAfter.current = null
  }, [text])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === "Enter" && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      // The only place a typed command starts from.
      if (mod) caretAfter.current = insertCursorText(active, e.shiftKey)
      else void runCommandLine(e.shiftKey)
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      if (text === "" && message === null) focusPanel()
      else clearCommandLine()
    } else if (
      (e.key === "Tab" || e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !mod &&
      !e.altKey
    ) {
      // Back to the files, as in Total Commander.
      e.preventDefault()
      e.stopPropagation()
      focusPanel()
    }
  }

  const historyChord = chords["cmd.history"]?.[0]
  const focusChord = chords["cmd.focus"]?.[0]
  const entries: MenuEntry[] = history.map((line, index) => ({
    id: `history-${index}`,
    label: <span className="font-mono">{line}</span>,
    onSelect: () => pickHistory(index),
  }))

  return (
    <div
      role="group"
      aria-label={t("Command line")}
      data-testid="command-line"
      className="relative flex h-8 shrink-0 items-center gap-2 border-t border-border bg-chrome px-2 text-xs"
    >
      <Tooltip content={path}>
        <span
          data-testid="command-prompt"
          className="max-w-[40%] shrink-0 truncate font-mono text-muted"
          // The end of a long path is the part that tells folders apart.
          style={{ direction: "rtl", textAlign: "left" }}
        >
          <bdi>{path}</bdi>
          &gt;
        </span>
      </Tooltip>
      <input
        ref={input}
        aria-label={t("Command line")}
        aria-invalid={message !== null}
        aria-describedby={message ? "command-line-message" : undefined}
        aria-keyshortcuts={
          focusChord ? formatChord(focusChord).replace("Ctrl", "Control") : undefined
        }
        value={text}
        maxLength={MAX_COMMAND_CHARS}
        placeholder={t("Enter runs the line · Shift+Enter runs it in a console window")}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onChange={(e) => setCommandText(e.target.value)}
        onKeyDown={onKeyDown}
        className="h-6 min-w-0 flex-1 rounded border border-transparent bg-canvas px-1.5 font-mono text-text outline-none focus:border-accent"
      />
      <Tooltip
        content={
          historyChord
            ? `${t("Command history")} (${formatChord(historyChord)})`
            : t("Command history")
        }
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("Command history")}
          aria-haspopup="menu"
          aria-expanded={historyOpen}
          disabled={history.length === 0}
          onClick={openCommandHistory}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted hover:bg-raised hover:text-text disabled:opacity-40"
        >
          ▾
        </button>
      </Tooltip>
      {message && (
        <p
          id="command-line-message"
          role="alert"
          className="absolute right-2 bottom-full left-2 z-10 rounded-t border border-b-0 border-border bg-raised px-2 py-1 text-danger shadow"
        >
          {message}
        </p>
      )}
      {historyOpen && (
        <PopupMenu
          label={t("Command history")}
          testId="command-history"
          entries={entries}
          onClose={closeCommandHistory}
          className="right-2 bottom-full left-2"
          // The menu's own limit is relative to this one-line bar.
          style={{ maxHeight: "min(28rem, 60vh)" }}
        />
      )}
    </div>
  )
}
