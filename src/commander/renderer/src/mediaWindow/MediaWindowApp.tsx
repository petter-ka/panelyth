import type { ContentItem, MediaWindowCommand } from "@panelyth/contracts"
import { MediaViewerOverlay, useVideoPrefs } from "@panelyth/media-ui"
import { Button } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import { useCallback, useEffect, useRef, useState } from "react"
import { bridge } from "../bridge"

/** Preview lane of its own, so the window never drops the panels' queued work. */
export const MEDIA_WINDOW_LANE = "cmd-media-window"

/** How long a note about a file command stays on screen. */
export const NOTE_MS = 2000

const closeWindow = (): void => window.close()

/** Keys go back to the picture after the confirmation. */
const focusSurface = (): void =>
  document.querySelector<HTMLElement>('[data-testid="media-viewer"]')?.focus()

/**
 * Opened for a file from the OS ("Open with"): there is no app window behind
 * this one. Main says so in the URL fragment.
 */
export const standsAlone = (hash = window.location.hash): boolean =>
  new URLSearchParams(hash.replace(/^#/, "")).get("alone") === "1"

/** What the window says once a command ran. */
function doneNote(command: MediaWindowCommand): string {
  switch (command) {
    case "copy":
      return t("{count, plural, one {# item} other {# items}} copied", { count: 1 })
    case "cut":
      return t("{count, plural, one {# item} other {# items}} cut", { count: 1 })
    case "paste":
      return t("Pasting into this folder…")
    case "trash":
      return t("Moved {count, plural, one {# item} other {# items}} to the trash", { count: 1 })
    case "delete":
      return t("Deleted {count, plural, one {# item} other {# items}}", { count: 1 })
  }
}

/**
 * The full-screen media window (ADR-0033 amended): the shared media overlay
 * (zoom, fit, the Panelyth player, previous / next) over a black window. The
 * window that opened it owns the listing, so every step is a question to it.
 * A window opened for a file from the OS asks main the same way; there a
 * double-click does not close it but takes the picture into the viewer, at
 * its folder.
 *
 * The file keys (copy, cut, paste, Delete, Shift+Delete) go to the opener,
 * which carries them out on the file shown; after a delete the window shows
 * the next file, or closes when none is left. A delete asks here first,
 * since the app's own dialogs are behind this window: always for good, and
 * for the trash unless Settings → Appearance → Full screen says not to.
 */
export function MediaWindowApp() {
  const [alone] = useState(standsAlone)
  const [item, setItem] = useState<ContentItem | null>(null)
  const [failed, setFailed] = useState(false)
  const [wheelMode, setWheelMode] = useState<"zoom" | "previousNext">("zoom")
  const [confirming, setConfirming] = useState<"trash" | "delete" | null>(null)
  const confirmTrash = useVideoPrefs((s) => s.confirmDelete)
  const [note, setNote] = useState<string | null>(null)
  const busy = useRef(false)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const say = useCallback((text: string): void => {
    setNote(text)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS)
  }, [])
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current)
    },
    [],
  )

  const step = useCallback(async (direction: -1 | 0 | 1): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try {
      const next = await bridge.mediaWindowStep(direction)
      if (next) setItem(next)
      else if (direction === 0) setFailed(true)
    } catch {
      if (direction === 0) setFailed(true)
    } finally {
      busy.current = false
    }
  }, [])

  const run = useCallback(
    async (command: MediaWindowCommand): Promise<void> => {
      if (busy.current) return
      busy.current = true
      try {
        const { item: next, done } = await bridge.mediaWindowCommand(command)
        if (!done) {
          say(t("The operation failed."))
          return
        }
        say(doneNote(command))
        if (command === "trash" || command === "delete") {
          if (next) setItem(next)
          else closeWindow()
        }
      } catch {
        say(t("The operation failed."))
      } finally {
        busy.current = false
      }
    },
    [say],
  )

  const onCommand = useCallback(
    (command: MediaWindowCommand): void => {
      if (command === "delete" || (command === "trash" && confirmTrash)) setConfirming(command)
      else void run(command)
    },
    [run, confirmTrash],
  )

  useEffect(() => {
    let live = true
    bridge
      .mediaWindowStep(0)
      .then((first) => {
        if (!live) return
        if (first) setItem(first)
        else setFailed(true)
      })
      .catch(() => live && setFailed(true))
    // Settings → Mouse wheel (the viewer's setting, shared through library.db).
    bridge
      .libraryNow()
      .then((library) => {
        const viewer = library.settings["viewer"] as { wheelMode?: unknown } | undefined
        if (live && viewer?.wheelMode === "previousNext") setWheelMode("previousNext")
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  if (failed) {
    return (
      <div
        role="alert"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => e.key === "Escape" && closeWindow()}
        onDoubleClick={closeWindow}
        className="grid h-screen place-items-center bg-canvas p-6 text-sm text-muted outline-none"
      >
        {t("This file can't be shown in a window.")}
      </div>
    )
  }
  if (!item) return <div className="h-screen bg-canvas" />
  const answer = (confirmed: boolean): void => {
    const command = confirming
    setConfirming(null)
    focusSurface()
    if (confirmed && command) void run(command)
  }
  return (
    <>
      <MediaViewerOverlay
        key={item.id}
        item={item}
        lane={MEDIA_WINDOW_LANE}
        wheelMode={wheelMode}
        onClose={closeWindow}
        onStep={(direction) => void step(direction)}
        {...(alone
          ? {
              // Main opens the viewer on this file's folder and closes this window.
              onShowInApp: () => void bridge.mediaWindowReveal().catch(() => undefined),
            }
          : {
              closeOnDoubleClick: true,
              onCommand,
              // The main window's viewer opens its editor on the picture; this window is done.
              onEdit: () =>
                void bridge
                  .editInViewer(item.id)
                  .then(closeWindow)
                  .catch(() => undefined),
            })}
      />
      {confirming !== null && (
        <div
          className="fixed inset-0 z-[110] grid place-items-center bg-black/50"
          onMouseDown={(e) => e.target === e.currentTarget && answer(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="media-delete-title"
            data-testid="media-delete-confirm"
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Escape") {
                e.preventDefault()
                answer(false)
              }
            }}
            className="glass-sheet flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-3 rounded-lg border border-border bg-chrome p-4 text-xs text-text shadow-xl shadow-black/40"
          >
            <h2 id="media-delete-title" className="text-[0.8125rem] font-semibold">
              {confirming === "delete"
                ? t("Delete {what} permanently?", { what: item.name })
                : t("Move {what} to the trash?", { what: item.name })}
            </h2>
            <p className="text-muted">
              {confirming === "delete"
                ? t("This can't be undone.")
                : t("You can turn this question off in Settings → Appearance → Full screen.")}
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => answer(false)}>{t("Cancel")}</Button>
              <Button
                variant={confirming === "delete" ? "danger" : "primary"}
                autoFocus
                onClick={() => answer(true)}
              >
                {confirming === "delete" ? t("Delete permanently") : t("Move to trash")}
              </Button>
            </div>
          </div>
        </div>
      )}
      {note && (
        <div
          role="status"
          className="glass-chip pointer-events-none fixed bottom-6 left-1/2 z-[110] -translate-x-1/2 rounded-md border border-border bg-chrome/90 px-3 py-1.5 text-xs text-text shadow"
        >
          {note}
        </div>
      )}
    </>
  )
}
