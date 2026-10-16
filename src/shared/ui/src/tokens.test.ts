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

  /**
   * What the backdrop filter makes of a gray behind a floating layer: its
   * contrast() then brightness(), each clamped as CSS filters are. Blur and
   * the ripple move pixels, so they keep the darkest and the lightest gray.
   */
  const toneOf = (
    selector: string,
    variable = "glass-backdrop",
  ): ((v: number) => number) | undefined => {
    const filter = new RegExp(`--${variable}:([^;]*);`).exec(body(selector))?.[1]
    if (!filter) return undefined
    const c = Number(/contrast\(([\d.]+)\)/.exec(filter)?.[1] ?? 1)
    const b = Number(/brightness\(([\d.]+)\)/.exec(filter)?.[1] ?? 1)
    const clamp = (v: number): number => Math.min(1, Math.max(0, v))
    return (v) => 255 * clamp(clamp((v / 255 - 0.5) * c + 0.5) * b)
  }

  /** The white gloss across the top of a floating layer, as an alpha (0 when none). */
  const sheenOf = (selector: string): number | undefined => {
    const v = /--glass-sheen:\s*([^;]*);/.exec(body(selector))?.[1]?.trim()
    if (v === undefined) return undefined
    return v === "transparent" ? 0 : Number(/rgb\(255 255 255 \/ ([\d.]+)\)/.exec(v)![1])
  }

  const glass = {
    light: mixes(':root[data-style="glass"]'),
    dark: mixes(':root[data-style="glass"].dark'),
  }
  const light = ':root[data-style="glass"]'
  const dark = ':root[data-style="glass"].dark'
  const identity = (v: number): number => v
  const tone = {
    light: toneOf(light) ?? identity,
    dark: toneOf(dark) ?? toneOf(light) ?? identity,
  }
  // Menus and popups have a recipe of their own.
  const menuTone = {
    light: toneOf(light, "glass-menu-backdrop") ?? identity,
    dark: toneOf(dark, "glass-menu-backdrop") ?? toneOf(light, "glass-menu-backdrop") ?? identity,
  }
  const sheen = { light: sheenOf(light) ?? 0, dark: sheenOf(dark) ?? sheenOf(light) ?? 0 }

  const over = (fg: string, p: number, bg: string): string =>
    `#${[1, 3, 5]
      .map((i) => {
        const [f, b] = [fg, bg].map((hex) => parseInt(hex.slice(i, i + 2), 16))
        return Math.round(f! * p + b! * (1 - p))
          .toString(16)
          .padStart(2, "0")
      })
      .join("")}`

  const pressShare =
    Number(
      /\.glass-press:is\(\[aria-pressed="true"\], \[aria-current="page"\]\) \{[^}]*color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\)/.exec(
        css,
      )![1],
    ) / 100

  const gray = (v: number): string => `#${Math.round(v).toString(16).padStart(2, "0").repeat(3)}`
  const readable = ["text", "muted", "accent", "danger"] as const

  /**
   * A floating layer's fill (styles.css, `:is(.glass-float, .glass-sheet)`):
   * a gradient whose stops mix the palette's accent, purple and blue into the
   * layer's base by the tint, laid over the backdrop at the share. Each stop
   * is checked, since text can sit over any of them.
   */
  const HUES = ["accent", "label-purple", "label-blue"] as const
  const BASE = { float: "raised", sheet: "chrome" } as const
  const percent = (selector: string, name: string): number | undefined => {
    const m = new RegExp(`--${name}:\\s*(\\d+)%`).exec(body(selector))
    return m ? Number(m[1]) / 100 : undefined
  }
  const layerMix = (scheme: "light" | "dark", kind: "float" | "sheet") => {
    const read = (name: string): number =>
      (scheme === "dark" ? percent(dark, name) : undefined) ?? percent(light, name)!
    return { tint: read(`glass-${kind}-tint`), share: read(`glass-${kind}-share`) }
  }
  const layerStops = (
    t: Record<string, string>,
    scheme: "light" | "dark",
    kind: "float" | "sheet",
    backdrop: string,
  ): string[] => {
    const { tint, share } = layerMix(scheme, kind)
    return HUES.map((hue) => over(over(t[hue]!, tint, t[BASE[kind]]!), share, backdrop))
  }

  it("defines each share it uses, in both schemes", () => {
    for (const name of ["fill", "content", "control", "chip", "solid", "bloom-1"]) {
      expect(glass.light[`glass-${name}`], name).toBeDefined()
    }
    for (const scheme of ["light", "dark"] as const) {
      for (const kind of ["float", "sheet"] as const) {
        const { tint, share } = layerMix(scheme, kind)
        expect(tint, `${scheme} ${kind} tint`).toBeGreaterThan(0)
        expect(share, `${scheme} ${kind} share`).toBeGreaterThan(0)
      }
    }
    // The model above is the rule's: each hue mixed by the tint into the base.
    for (const hue of HUES) expect(css).toContain(`var(--${hue}) var(--tint), var(--tint-base)`)
  })

  it("tone-maps the backdrop of floating layers: dark dims white, light lifts black", () => {
    expect(tone.dark(255)).toBeLessThan(96)
    expect(tone.light(0)).toBeGreaterThan(128)
    expect(menuTone.dark(255)).toBeLessThan(96)
    expect(menuTone.light(0)).toBeGreaterThan(128)
  })

  it.each(Object.entries(palettes).filter(([name]) => name.startsWith("dark")))(
    "an open menu or dialog is lighter than the app, never dimmed, even over black (%s)",
    (_name, t) => {
      const mix = (key: string): Mix => (glass.dark[key] ?? glass.light[key])!
      const fill = mix("glass-fill")
      const card = over(t[fill.token]!, fill.share, t.canvas!)
      for (const [kind, map] of [
        ["float", menuTone.dark],
        ["sheet", tone.dark],
      ] as const) {
        for (const shown of layerStops(t, "dark", kind, gray(map(0)))) {
          expect(luminance(shown) / luminance(card), `${kind} ${shown}`).toBeGreaterThanOrEqual(1.3)
        }
      }
    },
  )

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
        // A pressed toggle (.glass-press) shows its label in the text color on the accent tint.
        const pressed = over(t.accent!, pressShare, card)
        expect(contrast(t.text!, pressed), `text on pressed over ${w}`).toBeGreaterThanOrEqual(4.5)
        // The current app's glyph on the rail is the accent there (non-text: 3:1).
        expect(
          contrast(t.accent!, pressed),
          `accent glyph on pressed over ${w}`,
        ).toBeGreaterThanOrEqual(3)
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
      // Menus and dialogs tone-map what is behind them; chips show it as it is.
      const toned = (map: (v: number) => number): string[] => [gray(map(0)), gray(map(255))]
      const chip = mix("glass-chip")
      const layers = [
        {
          name: "menu",
          fills: (b: string) => layerStops(t, scheme, "float", b),
          backdrops: toned(menuTone[scheme]),
          glossy: true,
        },
        {
          name: "dialog",
          fills: (b: string) => layerStops(t, scheme, "sheet", b),
          backdrops: toned(tone[scheme]),
          glossy: true,
        },
        {
          name: "chip",
          fills: (b: string) => [over(t[chip.token]!, chip.share, b)],
          backdrops: [gray(0), gray(255)],
          glossy: false,
        },
      ]
      for (const layer of layers) {
        for (const plain of layer.backdrops.flatMap(layer.fills)) {
          const backdrop = plain
          // On the layer: its own fill, the gloss at the top, and a list well or a control inside.
          const surfaces: Record<string, string> = {
            layer: plain,
            content: over(t[mix("glass-content").token]!, mix("glass-content").share, plain),
            control: over(t[mix("glass-control").token]!, mix("glass-control").share, plain),
          }
          if (layer.glossy && sheen[scheme] > 0) {
            surfaces.gloss = over("#ffffff", sheen[scheme], plain)
          }
          for (const [surface, bg] of Object.entries(surfaces)) {
            for (const fg of readable) {
              expect(
                contrast(t[fg]!, bg),
                `${fg} on ${layer.name} ${surface} over ${backdrop}`,
              ).toBeGreaterThanOrEqual(4.5)
            }
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
