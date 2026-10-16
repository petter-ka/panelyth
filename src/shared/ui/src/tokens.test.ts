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

describe("liquid glass style (ADR-0041)", () => {
  // Text is drawn on translucent surfaces here, so the contrast that counts is
  // against what shows through: the composite over the wallpaper's strongest
  // colors for cards, and over a black or white picture for floating layers.
  const palettes = {
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

  const body = (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    if (start < 0) throw new Error(`missing ${selector}`)
    return css.slice(start, css.indexOf("}", start))
  }

  interface Mix {
    token: string
    share: number
    /** The other side of the mix; null is transparent. */
    with: string | null
  }

  const mixes = (selector: string): Record<string, Mix> =>
    Object.fromEntries(
      [
        ...body(selector).matchAll(
          /--(glass-[\w-]+): color-mix\(in srgb, var\(--([\w-]+?)(?:-solid)?\) (\d+)%, (?:transparent|var\(--([\w-]+?)(?:-solid)?\))\)/g,
        ),
      ].map((m) => [m[1]!, { token: m[2]!, share: Number(m[3]) / 100, with: m[4] ?? null }]),
    )

  const brightness = (selector: string): number | undefined => {
    const m = /--glass-backdrop:[^;]*brightness\(([\d.]+)\)/.exec(body(selector))
    return m ? Number(m[1]) : undefined
  }

  const glass = {
    light: mixes(':root[data-style="glass"]'),
    dark: mixes(':root[data-style="glass"].dark'),
  }
  const backdropBrightness = {
    light: brightness(':root[data-style="glass"]') ?? 1,
    dark:
      brightness(':root[data-style="glass"].dark') ?? brightness(':root[data-style="glass"]') ?? 1,
  }

  const over = (fg: string, p: number, bg: string): string =>
    `#${[1, 3, 5]
      .map((i) => {
        const [f, b] = [fg, bg].map((hex) => parseInt(hex.slice(i, i + 2), 16))
        return Math.round(f! * p + b! * (1 - p))
          .toString(16)
          .padStart(2, "0")
      })
      .join("")}`

  const gray = (v: number): string => `#${Math.round(v).toString(16).padStart(2, "0").repeat(3)}`
  const readable = ["text", "muted", "accent", "danger"] as const

  it("defines each share it uses, in both schemes", () => {
    for (const name of [
      "fill",
      "content",
      "control",
      "float",
      "sheet",
      "chip",
      "solid",
      "bloom-1",
    ]) {
      expect(glass.light[`glass-${name}`], name).toBeDefined()
    }
  })

  it.each(Object.entries(palettes))(
    "text, muted, accent and danger meet AA (4.5:1) on cards over the wallpaper (%s)",
    (name, t) => {
      const scheme =
        name === "light" || name === "beige" || name === "light-brown" ? "light" : "dark"
      const mix = (key: string): Mix => (glass[scheme][key] ?? glass.light[key])!
      const color = (m: Mix, under: string): string =>
        m.with === null ? over(t[m.token]!, m.share, under) : over(t[m.token]!, m.share, t[m.with]!)
      const wallpaper = [
        t.canvas!,
        ...["glass-bloom-1", "glass-bloom-2", "glass-bloom-3"].map((k) => color(mix(k), t.canvas!)),
      ]
      for (const w of wallpaper) {
        const card = color(mix("glass-fill"), w)
        const surfaces = {
          card,
          content: color(mix("glass-content"), card),
          control: color(mix("glass-control"), card),
          sticky: color(mix("glass-solid"), card),
        }
        for (const [surface, bg] of Object.entries(surfaces)) {
          for (const fg of readable) {
            expect(contrast(t[fg]!, bg), `${fg} on ${surface} over ${w}`).toBeGreaterThanOrEqual(
              4.5,
            )
          }
        }
      }
    },
  )

  it.each(Object.entries(palettes))(
    "menus, dialogs and chips keep AA over a black or a white picture (%s)",
    (name, t) => {
      const scheme =
        name === "light" || name === "beige" || name === "light-brown" ? "light" : "dark"
      const mix = (key: string): Mix => (glass[scheme][key] ?? glass.light[key])!
      const dim = backdropBrightness[scheme]
      // Menus and dialogs blur (and in dark, dim) what is behind them; chips do not.
      const layers = [
        { name: "menu", mix: mix("glass-float"), backdrops: [gray(0), gray(255 * dim)] },
        { name: "dialog", mix: mix("glass-sheet"), backdrops: [gray(0), gray(255 * dim)] },
        { name: "chip", mix: mix("glass-chip"), backdrops: [gray(0), gray(255)] },
      ]
      for (const layer of layers) {
        for (const backdrop of layer.backdrops) {
          const bg = over(t[layer.mix.token]!, layer.mix.share, backdrop)
          for (const fg of readable) {
            expect(
              contrast(t[fg]!, bg),
              `${fg} on ${layer.name} over ${backdrop}`,
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    },
  )

  it("keeps blur off the cards: only floating layers filter their backdrop", () => {
    const rules = [...css.matchAll(/([^{}]+)\{[^}]*backdrop-filter:[^}]*\}/g)].map((m) =>
      m[1]!.trim(),
    )
    expect(rules.length).toBeGreaterThan(0)
    for (const selector of rules) {
      expect(selector).not.toMatch(/glass-region|glass-chip|glass-page/)
    }
  })
})
