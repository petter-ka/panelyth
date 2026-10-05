import { MAX_RENAME_PATTERN_CHARS } from "@fastview/contracts"

// Batch-rename preview. Mirrors shared/sidecar/internal/jobs/pattern.go:
// {name} is the original name without its extension, {n} / {n:000} a
// counter zero-padded to the number of zeros. The extension is always kept.
// Go validates again; this only drives the preview and the OK button.

type Part = { literal: string } | { name: true } | { width: number }

export function parsePattern(pattern: string): Part[] | null {
  if (pattern === "" || pattern.length > MAX_RENAME_PATTERN_CHARS) return null
  const parts: Part[] = []
  let hasToken = false
  let rest = pattern
  while (rest.length > 0) {
    const open = rest.indexOf("{")
    if (open < 0) {
      parts.push({ literal: rest })
      break
    }
    if (open > 0) parts.push({ literal: rest.slice(0, open) })
    const end = rest.indexOf("}", open)
    if (end < 0) return null
    const token = rest.slice(open + 1, end)
    if (token === "name") parts.push({ name: true })
    else if (token === "n") parts.push({ width: 1 })
    else if (/^n:0{1,10}$/.test(token)) parts.push({ width: token.length - 2 })
    else return null
    hasToken = true
    rest = rest.slice(end + 1)
  }
  return hasToken ? parts : null
}

/** "a.b.jpg" -> ["a.b", ".jpg"]; dot files, names without extension and folders have none. */
export function splitExt(name: string, isDir: boolean): [string, string] {
  if (isDir) return [name, ""]
  const i = name.lastIndexOf(".")
  if (i <= 0 || i === name.length - 1) return [name, ""]
  return [name.slice(0, i), name.slice(i)]
}

export function applyPattern(parts: Part[], original: string, isDir: boolean, n: number): string {
  const [stem, ext] = splitExt(original, isDir)
  let out = ""
  for (const p of parts) {
    if ("literal" in p) out += p.literal
    else if ("name" in p) out += stem
    else out += String(n).padStart(p.width, "0")
  }
  return out.trim() + ext
}
