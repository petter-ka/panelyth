import { ESLint } from "eslint"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Package boundaries (ADR-0025, ADR-0031 "Code layout"; Stage P01): an app
// never imports the other app, a shared package never imports an app or a
// package above it, and renderer code never imports Electron or Node. The
// rules are in the root eslint.config.js; this test fails when they stop
// firing, and when a package.json declares a dependency the rules forbid.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const eslint = new ESLint({ cwd: root })

/** The restricted-import messages for a file with this one import. */
async function restricted(file: string, specifier: string): Promise<string[]> {
  const [result] = await eslint.lintText(`import ${JSON.stringify(specifier)}\n`, {
    filePath: join(root, file),
  })
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message)
}

const cases: [file: string, specifier: string, allowed: boolean][] = [
  // A package never imports an app, by name or by path.
  ["src/shared/ui/src/x.tsx", "@panelyth/renderer", false],
  ["src/shared/ui/src/x.tsx", "@panelyth/commander", false],
  ["src/shared/renderer-core/src/x.ts", "../../../viewer/renderer/src/bridge", false],
  ["src/shared/media-ui/src/x.tsx", "../../../commander/renderer/src/bridge", false],
  ["src/shared/contracts/src/x.ts", "@panelyth/renderer", false],
  ["src/shared/i18n/src/x.ts", "@panelyth/commander", false],
  ["src/shared/i18n/src/cli.ts", "@panelyth/commander", false],
  ["src/shared/docviewer/src/x.tsx", "@panelyth/renderer", false],
  // Nor the shell.
  ["src/shared/ui/src/x.tsx", "@panelyth/desktop", false],
  // A package imports only the packages below it.
  ["src/shared/renderer-core/src/x.ts", "@panelyth/ui", false],
  ["src/shared/renderer-core/src/x.ts", "@panelyth/media-ui", false],
  ["src/shared/ui/src/x.tsx", "@panelyth/media-ui", false],
  ["src/shared/contracts/src/x.ts", "@panelyth/renderer-core", false],
  ["src/shared/ui/src/x.tsx", "@panelyth/renderer-core", true],
  ["src/shared/ui/src/x.tsx", "@panelyth/ui/styles.css", true],
  ["src/shared/media-ui/src/x.tsx", "@panelyth/ui", true],
  ["src/shared/renderer-core/src/x.ts", "@panelyth/contracts", true],
  // An app never imports the other app.
  ["src/viewer/renderer/src/x.tsx", "@panelyth/commander", false],
  ["src/viewer/renderer/src/x.tsx", "../../../commander/renderer/src/features/panels", false],
  ["src/commander/renderer/src/x.tsx", "@panelyth/renderer", false],
  ["src/commander/renderer/src/x.tsx", "../../../viewer/renderer/src/features/folder", false],
  ["src/viewer/renderer/src/x.tsx", "@panelyth/media-ui", true],
  ["src/viewer/renderer/src/features/viewer/x.ts", "../folder/folderStore", true],
  ["src/commander/renderer/src/x.tsx", "@panelyth/renderer-core", true],
  // Renderer code never imports Electron or Node.
  ["src/shared/renderer-core/src/x.ts", "electron", false],
  ["src/shared/media-ui/src/x.tsx", "node:fs", false],
  ["src/shared/contracts/src/x.ts", "node:path", false],
  ["src/shared/docviewer/src/x.tsx", "node:fs", false],
  ["src/viewer/renderer/src/x.tsx", "electron", false],
  ["src/commander/renderer/src/x.tsx", "node:child_process", false],
  // The catalog tooling runs in Node; the shell is not renderer code.
  ["src/shared/i18n/src/extract.ts", "node:fs", true],
  ["src/shared/desktop/src/main/x.ts", "electron", true],
]

describe("package boundaries (lint)", () => {
  it.each(cases)("%s importing %s: allowed %s", async (file, specifier, allowed) => {
    const messages = await restricted(file, specifier)
    if (allowed) expect(messages).toEqual([])
    else expect(messages).toHaveLength(1)
  })
})

describe("package boundaries (manifests)", () => {
  /** Bottom to top, as in eslint.config.js. */
  const layers = ["contracts", "i18n", "renderer-core", "ui", "media-ui"]
  const outside = ["@panelyth/renderer", "@panelyth/commander", "@panelyth/desktop"]

  const workspaceDeps = (dir: string): string[] => {
    const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >
    return ["dependencies", "devDependencies", "peerDependencies"]
      .flatMap((field) => Object.keys(manifest[field] ?? {}))
      .filter((name) => name.startsWith("@panelyth/"))
  }

  it.each(layers)("@panelyth/%s depends only on the packages below it", (name) => {
    const below = layers.slice(0, layers.indexOf(name)).map((n) => `@panelyth/${n}`)
    for (const dep of workspaceDeps(`src/shared/${name}`)) expect(below).toContain(dep)
  })

  it("the document window depends on no app", () => {
    for (const dep of workspaceDeps("src/shared/docviewer")) expect(outside).not.toContain(dep)
  })

  it("an app does not depend on the other app", () => {
    expect(workspaceDeps("src/viewer/renderer")).not.toContain("@panelyth/commander")
    expect(workspaceDeps("src/commander/renderer")).not.toContain("@panelyth/renderer")
  })
})
