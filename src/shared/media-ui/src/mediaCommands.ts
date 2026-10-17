import type { MediaWindowCommand } from "@panelyth/contracts"

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">

/** The letter key, by its character or (another keyboard layout) by its position. */
const letter = (e: KeyLike, char: string): boolean =>
  e.key.toLowerCase() === char || e.code === `Key${char.toUpperCase()}`

/**
 * The file commands of the full-screen surface, with the apps' default keys:
 * Ctrl/Cmd+C, Ctrl/Cmd+X and Ctrl/Cmd+V for the file clipboard, Delete (and
 * Cmd+Backspace) for the trash, Shift+Delete (and Cmd+Option+Backspace) to
 * delete for good. Anything else: null.
 */
export function mediaCommandOf(e: KeyLike): MediaWindowCommand | null {
  const mod = e.ctrlKey || e.metaKey
  if (e.key === "Delete" && !mod && !e.altKey) return e.shiftKey ? "delete" : "trash"
  if (e.key === "Backspace" && e.metaKey && !e.ctrlKey && !e.shiftKey)
    return e.altKey ? "delete" : "trash"
  if (!mod || e.altKey || e.shiftKey) return null
  if (letter(e, "c")) return "copy"
  if (letter(e, "x")) return "cut"
  if (letter(e, "v")) return "paste"
  return null
}
