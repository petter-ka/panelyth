import { app, nativeImage, type NativeImage, type WebContents } from "electron"
import { appIconPath } from "./paths"

// Files to other apps (ADR-0040): the OS's own drag, started for the view
// whose page cancelled its drag. Its icon is the OS's for the first file, or
// the app's where the OS has none (macOS refuses a drag without one).

let fallback: NativeImage | null = null

async function dragIcon(path: string): Promise<NativeImage> {
  const icon = await app.getFileIcon(path, { size: "normal" }).catch(() => null)
  if (icon && !icon.isEmpty()) return icon
  fallback ??= nativeImage.createFromPath(appIconPath()).resize({ width: 32, height: 32 })
  return fallback
}

export async function startFileDrag(sender: WebContents, files: readonly string[]): Promise<void> {
  const first = files[0]
  if (!first || sender.isDestroyed()) return
  const icon = await dragIcon(first)
  if (sender.isDestroyed()) return
  sender.startDrag({ file: first, files: [...files], icon })
}
