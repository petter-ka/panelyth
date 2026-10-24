import type { TextEditorSession } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { decodeBytes } from "./decode"

/**
 * The file's text: one GET of the session's read-only token URL (the bytes
 * never travel over IPC), the byte order mark skipped, decoded in the file's
 * encoding. Malformed bytes become U+FFFD; the sidecar refused binary files.
 */
export async function readSessionText(
  session: TextEditorSession,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    session.src,
    signal ? { signal, cache: "no-store" } : { cache: "no-store" },
  )
  if (!response.ok) {
    throw new Error(t("The file could not be read ({status}).", { status: response.status }))
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return decodeBytes(bytes, session.encoding, session.bom)
}
