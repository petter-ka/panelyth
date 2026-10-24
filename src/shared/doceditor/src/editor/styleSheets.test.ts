import { describe, expect, it } from "vitest"
import { mergeModules, mountAdopted } from "./styleSheets"

const mod = (rules: string) => ({ getRules: () => rules })

describe("mergeModules", () => {
  it("adds new modules in order and keeps mounted ones in front", () => {
    const a = mod("a")
    const b = mod("b")
    const c = mod("c")
    const list = [a]
    expect(mergeModules(list, [a, b])).toBe(true)
    expect(mergeModules(list, [a, b])).toBe(false)
    expect(mergeModules(list, [c, a])).toBe(true)
    expect(list).toEqual([c, a, b])
  })

  it("reorders on a conflicting order, like style-mod", () => {
    const a = mod("a")
    const b = mod("b")
    const list = [a, b]
    expect(mergeModules(list, [b, a])).toBe(true)
    expect(list).toEqual([b, a])
  })
})

describe("mountAdopted", () => {
  it("writes the rules into one constructed sheet adopted in front", () => {
    const texts: string[] = []
    const sheet = { replaceSync: (text: string) => texts.push(text) }
    const own = {} as CSSStyleSheet
    const root = { adoptedStyleSheets: [own] }
    let made = 0
    const make = () => {
      made++
      return sheet
    }
    const a = mod(".a{}")
    const b = mod(".b{}")
    expect(mountAdopted(root, [a], make)).toBe(true)
    expect(mountAdopted(root, [a, b], make)).toBe(true)
    expect(mountAdopted(root, [a, b], make)).toBe(true)
    expect(made).toBe(1)
    expect(texts).toEqual([".a{}", ".a{}\n.b{}"])
    expect(root.adoptedStyleSheets).toEqual([sheet, own])
  })

  it("declines a root that cannot adopt sheets", () => {
    expect(mountAdopted({}, [mod("x")], () => ({ replaceSync: () => undefined }))).toBe(false)
  })
})
