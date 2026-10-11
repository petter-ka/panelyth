import { useEffect, useRef, useState } from "react"
import type { MediaKind } from "../params"
import { t } from "@panelyth/i18n"

/**
 * The frameless full-screen media window's page: the image or video fills the
 * screen on black, with no header. Esc is handled by main; a double-click
 * closes the window too. The source is a read-only token: element loads only.
 */
export function MediaView({ kind, name, src }: { kind: MediaKind; name: string; src: string }) {
  const [failed, setFailed] = useState(false)
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    video.current?.focus()
  }, [])

  const close = (): void => window.close()

  if (failed) {
    return (
      <p
        role="alert"
        className="grid h-screen place-items-center bg-black p-6 text-sm text-neutral-300"
        onDoubleClick={close}
      >
        {t("{name} can't be shown.", { name })}
      </p>
    )
  }
  return (
    <div className="h-screen w-screen bg-black" data-testid="media-window">
      {kind === "image" ? (
        <img
          src={src}
          alt={name}
          draggable={false}
          className="size-full object-contain"
          onDoubleClick={close}
          onError={() => setFailed(true)}
        />
      ) : (
        <video
          ref={video}
          src={src}
          aria-label={name}
          className="size-full bg-black object-contain outline-none"
          controls
          autoPlay
          onError={() => setFailed(true)}
        />
      )}
    </div>
  )
}
