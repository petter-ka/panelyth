import { useEffect, useState } from "react"
import { bridge } from "../bridge"
import { ByteSource } from "../features/bytes"
import { DETECT_BYTES, detectEncoding, type Detection } from "../features/text"

const LOADING: ByteFile = { status: "loading" }

export type ByteFile =
  | { status: "loading" }
  | { status: "ready"; source: ByteSource; detection: Detection }
  | { status: "failed"; message: string }

/**
 * A file's bytes for the text and hex views: a token URL from main
 * (file.open), then the first window for encoding detection. Only while
 * `enabled` (an image in image mode never opens its bytes).
 */
export function useByteFile(entryId: number, enabled = true): ByteFile {
  // Keyed by the entry, so another file shows "loading" without a reset in the effect.
  const [state, setState] = useState<{ entryId: number; file: ByteFile } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    void (async () => {
      const file = await bridge.openFile(entryId)
      const source = new ByteSource(file.url, file.sizeBytes)
      const detection = detectEncoding(await source.read(0, DETECT_BYTES))
      if (live) setState({ entryId, file: { status: "ready", source, detection } })
    })().catch((error: unknown) => {
      if (live)
        setState({
          entryId,
          file: {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
        })
    })
    return () => {
      live = false
    }
  }, [entryId, enabled])
  return state?.entryId === entryId ? state.file : LOADING
}
