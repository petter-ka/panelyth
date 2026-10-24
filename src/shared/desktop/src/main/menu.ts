// The native application menu (Stage P06): the app menu on macOS. On Windows
// and Linux no window shows its bar; the menu stays set for its shortcuts
// (Settings, zoom, full screen). It replaces Electron's default menu, whose Help
// points at Electron's own site and whose View reloads the page in a release.
// Items that belong to an app (About, Settings, Shortcuts) are sent to the
// app on screen; the rest is main's.
import type { MenuItemConstructorOptions } from "electron"
import type { AppId, AppTarget, MenuCommand, UpdateState } from "@panelyth/contracts"
import type { MenuText } from "./menuText"

export interface MenuContext {
  platform: NodeJS.Platform
  /** Development builds add Reload and the developer tools. */
  packaged: boolean
  commanderEnabled: boolean
  activeApp: AppId
  update: Pick<UpdateState, "mode" | "phase">
  text: MenuText
}

export interface MenuActions {
  /** Carried out by the app on screen. */
  command(command: MenuCommand): void
  switchApp(to: AppId): void
  openTarget(target: AppTarget): void
}

type Item = MenuItemConstructorOptions

const separator: Item = { type: "separator" }

/** The update item names the next step; with updates off there is none. */
function updateItem(ctx: MenuContext, actions: MenuActions): Item[] {
  if (ctx.update.mode === "off") return []
  const label =
    ctx.update.phase === "ready"
      ? ctx.text.restartToUpdate
      : ctx.update.phase === "available" || ctx.update.phase === "downloading"
        ? ctx.text.updateAvailable
        : ctx.text.checkForUpdates
  return [{ id: "update", label, click: () => actions.command("checkForUpdates") }]
}

export function menuTemplate(ctx: MenuContext, actions: MenuActions): Item[] {
  const { text } = ctx
  const mac = ctx.platform === "darwin"
  const about: Item = { id: "about", label: text.about, click: () => actions.command("about") }
  const settings: Item = {
    id: "settings",
    label: text.settings,
    accelerator: "CmdOrCtrl+,",
    click: () => actions.command("settings"),
  }

  const appMenu: Item = {
    label: "Panelyth",
    submenu: [
      about,
      ...updateItem(ctx, actions),
      separator,
      settings,
      separator,
      { role: "services", label: text.services },
      separator,
      { role: "hide", label: text.hide },
      { role: "hideOthers", label: text.hideOthers },
      { role: "unhide", label: text.showAll },
      separator,
      { role: "quit", label: text.quit },
    ],
  }

  const file: Item = {
    label: text.file,
    submenu: mac
      ? [{ role: "close", label: text.closeWindow }]
      : [settings, separator, { role: "quit", label: text.exit }],
  }

  const edit: Item = {
    label: text.edit,
    submenu: [
      { role: "undo", label: text.undo },
      { role: "redo", label: text.redo },
      separator,
      { role: "cut", label: text.cut },
      { role: "copy", label: text.copy },
      { role: "paste", label: text.paste },
      { role: "selectAll", label: text.selectAll },
    ],
  }

  const apps: Item[] = ctx.commanderEnabled
    ? [
        ...(["viewer", "commander"] as const).map((app): Item => ({
          id: `app-${app}`,
          // Product names are not translated (ADR-0034).
          label: app === "viewer" ? "Viewer" : "Commander",
          type: "radio",
          checked: ctx.activeApp === app,
          click: () => actions.switchApp(app),
        })),
        separator,
      ]
    : []

  const view: Item = {
    label: text.view,
    submenu: [
      ...apps,
      { role: "togglefullscreen", label: text.fullScreen },
      separator,
      { role: "resetZoom", label: text.actualSize },
      { role: "zoomIn", label: text.zoomIn },
      { role: "zoomOut", label: text.zoomOut },
      ...(ctx.packaged
        ? []
        : ([
            separator,
            { role: "reload" },
            { role: "forceReload" },
            { role: "toggleDevTools" },
          ] as Item[])),
    ],
  }

  const window: Item = {
    role: "window",
    label: text.window,
    submenu: [
      { role: "minimize", label: text.minimize },
      { role: "zoom", label: text.zoom },
      separator,
      { role: "front", label: text.bringAllToFront },
    ],
  }

  const target = (id: AppTarget, label: string): Item => ({
    id: `open-${id}`,
    label,
    click: () => actions.openTarget(id),
  })
  const help: Item = {
    role: "help",
    label: text.help,
    submenu: [
      { id: "shortcuts", label: text.shortcuts, click: () => actions.command("shortcuts") },
      separator,
      // macOS has these two in the app menu.
      ...(mac ? [] : [...updateItem(ctx, actions)]),
      target("releases", text.releaseNotes),
      target("issues", text.reportProblem),
      target("website", text.website),
      separator,
      target("logs", text.logs),
      target("notices", text.notices),
      ...(mac ? [] : [separator, about]),
    ],
  }

  return mac ? [appMenu, file, edit, view, window, help] : [file, edit, view, help]
}

/**
 * The parts of the context a rebuild depends on: the menu is rebuilt only
 * when this changes. The app on screen is not among them: a switch moves the
 * mark of the two View items in place (`markActiveApp`), so it never waits
 * for a new native menu.
 */
export function menuKey(ctx: MenuContext, language: string): string {
  const update =
    ctx.update.mode === "off"
      ? "off"
      : ctx.update.phase === "ready"
        ? "ready"
        : ctx.update.phase === "available" || ctx.update.phase === "downloading"
          ? "available"
          : "check"
  return [language, ctx.commanderEnabled, update].join("|")
}

/** The menu items a switch touches; Electron's Menu has them. */
export interface CheckableMenu {
  getMenuItemById(id: string): { checked: boolean } | null
}

/** Marks the app on screen in View, on the menu that is there. */
export function markActiveApp(menu: CheckableMenu | null, active: AppId): void {
  for (const app of ["viewer", "commander"] as const) {
    const item = menu?.getMenuItemById(`app-${app}`)
    if (item) item.checked = app === active
  }
}
