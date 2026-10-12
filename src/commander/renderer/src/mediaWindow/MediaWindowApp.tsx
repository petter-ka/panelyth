import type { ContentItem } from "@panelyth/contracts"
import { MediaViewerOverlay } from "@panelyth/media-ui"
import { t } from "@panelyth/i18n"
import { useCallback, useEffect, useRef, useState } from "react"
import { bridge } from "../bridge"

/** Preview lane of its own, so the window never drops the panels' queued work. */
export const MEDIA_WINDOW_LANE = "cmd-media-window"

const closeWindow = (): void => window.close()

/**
 * Opened for a file from the OS ("Open with"): there is no app window behind
 * this one. Main says so in the URL fragment.
 */
export const standsAlone = (hash = window.location.hash): boolean =>
  new URLSearchParams(hash.replace(/^#/, "")).get("alone") === "1"

/**
 * The full-screen media window (ADR-0033 amended): the shared media overlay
 * (zoom, fit, the Panelyth player, previous / next) over a black window. The
 * window that opened it owns the listing, so every step is a question to it.
 * A window opened for a file from the OS asks main the same way; there a
 * double-click does not close it but takes the picture into the viewer, at
 * its folder.
 */
export function MediaWindowApp() {
  const [alone] = useState(standsAlone)
  const [item, setItem] = useState<ContentItem | null>(null)
  const [failed, setFailed] = useState(false)
  const [wheelMode, setWheelMode] = useState<"zoom" | "previousNext">("zoom")
  const busy = useRef(false)

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
  return (
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
            // The main window's viewer opens its editor on the picture; this window is done.
            onEdit: () =>
              void bridge
                .editInViewer(item.id)
                .then(closeWindow)
                .catch(() => undefined),
          })}
    />
  )
}
