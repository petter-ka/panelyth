// Guards the design rules in docs/shared/DESIGN-SYSTEM.md ("Theme and color") against
// the real token file: neutral grays and WCAG AA contrast in both themes.
import { describe, expect, it } from "vitest"
import { fieldLook } from "./field"
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

  it("a field's border meets non-text contrast (3:1) on the chrome around it", () => {
    // fieldLook draws the border as `muted` at a share of opacity over the field's own fill.
    const share = Number(/border-muted\/(\d+)/.exec(fieldLook)![1]) / 100
    const border = `#${[1, 3, 5]
      .map((i) => {
        const [fg, bg] = [t.muted!, t.raised!].map((hex) => parseInt(hex.slice(i, i + 2), 16))
        return Math.round(fg! * share + bg! * (1 - share))
          .toString(16)
          .padStart(2, "0")
      })
      .join("")}`
    expect(contrast(border, t.chrome!)).toBeGreaterThanOrEqual(3)
  })
})

describe("caption sizes", () => {
  // The small interface size has a 14 px root: 0.6875rem alone would be 9.6 px.
  const roots = [...css.matchAll(/data-interface-size="\w+"\] \{\s*font-size: (\d+)px/g)].map((m) =>
    Number(m[1]),
  )

  it.each(["2xs", "3xs"])("--text-%s never goes under 10 px", (name) => {
    const value = new RegExp(`--text-${name}: max\\(([\\d.]+)rem, (\\d+)px\\)`).exec(css)
    expect(value, `--text-${name}`).not.toBeNull()
    const [rem, floor] = [Number(value![1]), Number(value![2])]
    expect(roots).toEqual([14, 16, 18, 20]) // S, M, L, XL
    expect(floor).toBeGreaterThanOrEqual(10)
    // The floor is only a floor: the larger sizes keep the size in rem.
    expect(rem * Math.max(...roots)).toBeGreaterThan(floor)
  })
})

describe("scrollbars", () => {
  // Every theme, the tinted ones too: the thumb is mixed from the theme's own muted color.
  const all = {
    ...themes,
    ...Object.fromEntries(
      ["dark-purple", "dark-brown", "beige", "light-brown"].map((name) => [
        name,
        {
          ...themes[name.startsWith("dark") ? "dark" : "light"],
          ...block(`:root[data-theme="${name}"]`),
        },
      ]),
    ),
  }
  const share = (name: string): number =>
    Number(
      new RegExp(
        `--scrollbar-${name}: color-mix\\(in srgb, var\\(--muted\\) (\\d+)%, transparent\\)`,
      ).exec(css)![1],
    ) / 100
  const over = (fg: string, bg: string, p: number): string =>
    `#${[1, 3, 5]
      .map((i) => {
        const [f, b] = [fg, bg].map((hex) => parseInt(hex.slice(i, i + 2), 16))
        return Math.round(f! * p + b! * (1 - p))
          .toString(16)
          .padStart(2, "0")
      })
      .join("")}`

  it("take the theme's colors and leave the accent to focus and selection", () => {
    expect(css).not.toMatch(/--scrollbar-[\w-]+:[^;]*(#|accent)/)
    expect(css).not.toMatch(/scrollbar-(color|width):/)
  })

  it.each(Object.entries(all))("stay quiet at rest and reach 3:1 when hovered (%s)", (_name, t) => {
    for (const surface of ["canvas", "chrome"] as const) {
      const rest = contrast(over(t.muted!, t[surface]!, share("thumb")), t[surface]!)
      const hover = contrast(over(t.muted!, t[surface]!, share("thumb-hover")), t[surface]!)
      expect(rest, `rest on ${surface}`).toBeGreaterThanOrEqual(1.8)
      expect(hover, `hover on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })
})
