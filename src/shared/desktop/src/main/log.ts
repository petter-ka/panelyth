import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, rename, stat } from "node:fs/promises"
import { join } from "node:path"

type Fields = Record<string, unknown>

export interface Logger {
  info(message: string, fields?: Fields): void
  warn(message: string, fields?: Fields): void
  error(message: string, fields?: Fields): void
  /** A raw stderr line from the sidecar (already structured JSON). */
  sidecar(line: string): void
}

const MAX_SESSION_BYTES = 10 * 1024 * 1024
const ROTATE_AT_BYTES = 5 * 1024 * 1024

/**
 * Append-only JSON-lines log. The previous log is rotated once at startup,
 * and a session stops writing after MAX_SESSION_BYTES so a crash loop cannot
 * fill the disk. All I/O is asynchronous.
 */
export async function createFileLogger(dir: string, mirrorToConsole: boolean): Promise<Logger> {
  const file = join(dir, "panelyth.log")
  await mkdir(dir, { recursive: true })
  try {
    if ((await stat(file)).size > ROTATE_AT_BYTES) await rename(file, join(dir, "panelyth.1.log"))
  } catch {
    // no previous log
  }
  const stream: WriteStream = createWriteStream(file, { flags: "a" })
  let written = 0
  let capped = false

  const write = (line: string): void => {
    if (mirrorToConsole) console.log(line)
    if (capped) return
    written += line.length + 1
    if (written > MAX_SESSION_BYTES) {
      capped = true
      stream.write(
        JSON.stringify({
          time: new Date().toISOString(),
          level: "WARN",
          msg: "log size cap reached",
        }) + "\n",
      )
      return
    }
    stream.write(line + "\n")
  }

  const entry = (level: string) => (msg: string, fields?: Fields) =>
    write(
      JSON.stringify({ time: new Date().toISOString(), level, component: "main", msg, ...fields }),
    )

  return {
    info: entry("INFO"),
    warn: entry("WARN"),
    error: entry("ERROR"),
    sidecar: write,
  }
}

/** Console-only logger used before the file logger exists and in tests. */
export const consoleLogger: Logger = {
  info: (msg, fields) => console.log(msg, fields ?? ""),
  warn: (msg, fields) => console.warn(msg, fields ?? ""),
  error: (msg, fields) => console.error(msg, fields ?? ""),
  sidecar: (line) => console.error(line),
}
