import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { repoRoot } from "../launch"

// Each app's index.html holds its outline until React renders
// (docs/shared/APP-SWITCHING.md, "Loading screen"): never an empty surface,
// whatever the machine's speed. The paint checks in switch.spec.ts and
// system.spec.ts see it on screen; the viewer's window is shown only once it
// has painted, so its outline is guarded here, with the others. No app runs.

const PAGES = {
  viewer: join(repoRoot, "src", "viewer", "renderer", "index.html"),
  commander: join(repoRoot, "src", "commander", "renderer", "index.html"),
  system: join(repoRoot, "src", "system", "renderer", "index.html"),
}
/** Each app's glyph by a path of it (AppSwitchButton.tsx). */
const GLYPHS = {
  viewer: 'x="1.5" y="1.5" width="5.5" height="5.5"',
  commander: 'x="1.5" y="2.5" width="5.5" height="11"',
  system: 'd="M2.2 11.5a6 6 0 1 1 11.6 0"',
}

/** The boot screen inside #root, up to the module script. */
function outlineOf(path: string): string {
  const html = readFileSync(path, "utf8")
  return html.slice(html.indexOf('<div id="root">'), html.indexOf('<script type="module"'))
}

test.describe("the apps' boot outlines", () => {
  for (const [app, path] of Object.entries(PAGES) as [keyof typeof PAGES, string][]) {
    test(`the ${app}'s index.html holds its outline`, () => {
      const outline = outlineOf(path)
      // The outline, not a lone spinner.
      expect(outline).toContain('class="boot-screen boot-skeleton"')
      expect(outline).toContain('class="app-rail')
      expect(outline).toContain('class="title-bar ')
      expect(outline).not.toContain("pending-spinner")
      expect(outline.match(/skeleton-bone|bg-skeleton/g)?.length ?? 0).toBeGreaterThan(10)
      // The rail's glyphs, the app's own in the accent color.
      for (const glyph of Object.values(GLYPHS)) expect(outline).toContain(glyph)
      const own = outline.indexOf(GLYPHS[app])
      expect(outline.lastIndexOf("text-accent", own)).toBeGreaterThan(
        outline.lastIndexOf("text-muted", own),
      )
      // No inline style (the CSP allows none), and no words but the app's name.
      expect(outline).not.toMatch(/\sstyle=/)
      const words = outline
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, " ")
        .split(/\s+/)
        .filter(Boolean)
      expect(words.join(" ")).toMatch(/^Panelyth( Commander| System)?$/)
    })
  }
})
