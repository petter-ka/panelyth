import { StyleModule } from "style-mod"

// CodeMirror's styles under the window's CSP (style-src 'self', no
// 'unsafe-inline'). style-mod uses a constructed style sheet only in a shadow
// root; in a document it writes a <style> element, which that CSP blocks, and
// the editor would show unstyled. This puts the document's modules into one
// constructed sheet in document.adoptedStyleSheets instead (CSP does not apply
// to constructed sheets). Shadow roots keep style-mod's own way.

interface Mountable {
  getRules(): string
}

interface AdoptingRoot {
  adoptedStyleSheets: CSSStyleSheet[]
}

type Mount = (
  root: Document | ShadowRoot,
  modules: StyleModule | readonly StyleModule[],
  options?: { nonce?: string },
) => void

interface Sheet {
  replaceSync(text: string): void
}

const sheets = new WeakMap<object, { sheet: Sheet; modules: Mountable[] }>()
let installed = false

/**
 * Orders the mounted modules as style-mod does: the modules of a mount keep
 * their order, the ones mounted before stay in front. True when the list changed.
 */
export function mergeModules(mounted: Mountable[], modules: readonly Mountable[]): boolean {
  let changed = false
  let j = 0
  for (const mod of modules) {
    let index = mounted.indexOf(mod)
    if (index < j && index > -1) {
      mounted.splice(index, 1)
      changed = true
      j--
      index = -1
    }
    if (index === -1) {
      mounted.splice(j++, 0, mod)
      changed = true
    } else {
      j = index + 1
    }
  }
  return changed
}

/** Mounts modules into a root's constructed sheet; false when the root cannot adopt sheets. */
export function mountAdopted(
  root: object,
  modules: readonly Mountable[],
  makeSheet: () => Sheet | null,
): boolean {
  if (!("adoptedStyleSheets" in root)) return false
  let entry = sheets.get(root)
  if (!entry) {
    const sheet = makeSheet()
    if (!sheet) return false
    entry = { sheet, modules: [] }
    sheets.set(root, entry)
  }
  if (mergeModules(entry.modules, modules)) {
    entry.sheet.replaceSync(entry.modules.map((m) => m.getRules()).join("\n"))
  }
  const adopting = root as AdoptingRoot
  const sheet = entry.sheet as CSSStyleSheet
  if (!adopting.adoptedStyleSheets.includes(sheet)) {
    // In front: the app's own sheets (and later themes) still win over the editor's base.
    adopting.adoptedStyleSheets = [sheet, ...adopting.adoptedStyleSheets]
  }
  return true
}

function constructSheet(): Sheet | null {
  try {
    const sheet = new CSSStyleSheet()
    return typeof sheet.replaceSync === "function" ? sheet : null
  } catch {
    return null
  }
}

/** Once, before the first editor view: documents get constructed sheets. */
export function adoptEditorStyles(): void {
  if (installed) return
  installed = true
  const original: Mount = StyleModule.mount.bind(StyleModule)
  const patched: Mount = (root, modules, options) => {
    const list = Array.isArray(modules) ? modules : [modules as StyleModule]
    const isDocument = typeof Document !== "undefined" && root instanceof Document
    if (isDocument && mountAdopted(root, list, constructSheet)) return
    original(root, modules as StyleModule[], options)
  }
  ;(StyleModule as unknown as { mount: Mount }).mount = patched
}
