// The product's fixed places (Stage P06): what the Help menu and Settings →
// About open. A renderer names a target; the URL or the path is main's.
import type { AboutInfo, AppTarget } from "@panelyth/contracts"

export const PRODUCT_NAME = "Panelyth"
export const COPYRIGHT = "Copyright © Panelyth contributors"

/** The project's home; releases are published there (electron-builder.config.mjs names the same repository). */
export const PROJECT_URL = "https://github.com/petter-ka/panelyth"

export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt"

const PAGES: Record<Exclude<AppTarget, "logs" | "notices">, string> = {
  releases: `${PROJECT_URL}/releases`,
  issues: `${PROJECT_URL}/issues`,
  website: PROJECT_URL,
}

export interface TargetDeps {
  logsDir(): string
  /** The notices file of this build; it exists in packaged builds and after `pnpm notices`. */
  noticesPath(): string
  exists(path: string): Promise<boolean>
  /** shell.openPath: resolves to "" on success, otherwise an error message. */
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
}

/** Opens one of the fixed targets. Throws with a message the app can show. */
export async function openTarget(target: AppTarget, deps: TargetDeps): Promise<void> {
  if (target === "logs" || target === "notices") {
    const path = target === "logs" ? deps.logsDir() : deps.noticesPath()
    if (target === "notices" && !(await deps.exists(path))) {
      throw new Error("the licence notices are part of packaged builds (pnpm notices writes them)")
    }
    const error = await deps.openPath(path)
    if (error) throw new Error(error)
    return
  }
  await deps.openExternal(PAGES[target])
}

export function aboutInfo(parts: {
  version: string
  sidecarVersion: string | null
  packaged: boolean
  versions: Readonly<Record<string, string | undefined>>
  platform: string
  arch: string
}): AboutInfo {
  return {
    name: PRODUCT_NAME,
    version: parts.version,
    sidecarVersion: parts.sidecarVersion,
    electron: parts.versions.electron ?? "",
    chrome: parts.versions.chrome ?? "",
    node: parts.versions.node ?? "",
    platform: `${parts.platform} ${parts.arch}`,
    packaged: parts.packaged,
    copyright: COPYRIGHT,
  }
}
