// Guards the design rules in docs/shared/DESIGN-SYSTEM.md ("Theme and color") against
// the real token file: neutral grays and WCAG AA contrast in both themes.
import { describe, expect, it } from "vitest"
import css from "./styles.css?raw"

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  const body = css.slice(start, css.indexOf("}", start))
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]),
  )
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const themes = { light: block(":root"), dark: block(":root.dark") }
const surfaces = ["canvas", "chrome", "raised"] as const

describe.each(Object.entries(themes))("%s theme tokens", (_name, t) => {
  it("defines the same token set as the other theme", () => {
    expect(Object.keys(t).sort()).toEqual(Object.keys(themes.dark).sort())
  })

  it("keeps every surface, border and text gray exactly neutral", () => {
    for (const key of [...surfaces, "border", "skeleton", "text", "muted"]) {
      const hex = t[key]!
      expect(hex.slice(1, 3), key).toBe(hex.slice(3, 5))
      expect(hex.slice(3, 5), key).toBe(hex.slice(5, 7))
    }
  })

  it.each(surfaces)("text, muted, accent and danger meet AA (4.5:1) on %s", (surface) => {
    for (const fg of ["text", "muted", "accent", "danger"]) {
      expect(contrast(t[fg]!, t[surface]!), `${fg} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(surfaces)("status colors meet non-text contrast (3:1) on %s", (surface) => {
    for (const fg of ["success", "warning"]) {
      expect(contrast(t[fg]!, t[surface]!), `${fg} on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it("accent foreground is readable on the accent", () => {
    expect(contrast(t["accent-foreground"]!, t.accent!)).toBeGreaterThanOrEqual(4.5)
  })

  it("canvas is darker than chrome, so media sits on the deepest field", () => {
    expect(luminance(t.canvas!)).toBeLessThan(luminance(t.chrome!))
  })
})
