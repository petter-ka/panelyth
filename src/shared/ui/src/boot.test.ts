import { beforeEach, describe, expect, it } from "vitest"
import boot from "../boot/boot.js?raw"
import { initInterfaceSize, initTheme } from "./appearance"

// boot.js applies the stored appearance before the first paint; the stores
// apply it again once the bundle runs. Both must land on the same state, or
// the page would change colors as it starts.

const state = () => {
  const root = document.documentElement
  return {
    dark: root.classList.contains("dark"),
    theme: root.dataset.theme,
    style: root.dataset.style,
    size: root.dataset.interfaceSize,
  }
}

function fresh(): void {
  const root = document.documentElement
  root.className = ""
  delete root.dataset.theme
  delete root.dataset.style
  delete root.dataset.interfaceSize
}

describe("boot.js", () => {
  beforeEach(() => {
    localStorage.clear()
    fresh()
  })

  it.each([
    {},
    { "panelyth.theme": "light" },
    { "panelyth.theme": "dark-purple", "panelyth.style": "glass" },
    { "panelyth.theme": "beige", "panelyth.interfaceSize": "xlarge" },
    { "panelyth.theme": "system" },
    { "panelyth.theme": "klingon", "panelyth.style": "aqua", "panelyth.interfaceSize": "huge" },
  ])("agrees with the appearance stores for %o", (stored: Record<string, string>) => {
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value)
    new Function(boot)()
    const early = state()
    fresh()
    initTheme()
    initInterfaceSize()
    expect(early).toEqual(state())
  })
})
