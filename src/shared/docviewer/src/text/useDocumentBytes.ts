import { useEffect, useState } from "react"
import { MAX_TEXT_BYTES } from "./decode"
import { t } from "@panelyth/i18n"

export type BytesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; bytes: Uint8Array; truncated: boolean }

/** Reads the first MAX_TEXT_BYTES of the token URL with one ranged fetch. */
export function useDocumentBytes(src: string, sizeBytes: number): BytesState {
  const [state, setState] = useState<BytesState>({ status: "loading" })
  useEffect(() => {
    const abort = new AbortController()
    setState({ status: "loading" })
    fetch(src, {
      signal: abort.signal,
      headers: sizeBytes > MAX_TEXT_BYTES ? { Range: `bytes=0-${MAX_TEXT_BYTES - 1}` } : {},
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(t("The file could not be read ({status}).", { status: response.status }))
        const bytes = new Uint8Array(await response.arrayBuffer())
        setState({ status: "ready", bytes, truncated: sizeBytes > bytes.length })
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setState({
          status: "error",
          message: error instanceof Error ? error.message : t("The file could not be read."),
        })
      })
    return () => abort.abort()
  }, [src, sizeBytes])
  return state
}
