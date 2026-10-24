// Takes the showcase's screenshots and records its hero video from the real
// app, running on the demo library (demo-library.mjs).
//
//   pnpm build                                  (the app, once)
//   node showcase/scripts/demo-library.mjs      (the library, once)
//   node showcase/scripts/capture.mjs [stills] [video]
//
// Output: showcase/src/media/*.webp, hero.mp4, hero.webm, hero-poster.jpg.
// Needs ffmpeg on the PATH (or PANELYTH_FFMPEG). The app's windows open on
// the screen while this runs; leave them alone until it is done.
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { demoRoot } from "./demo-library.mjs"
import { VIEW, launch, mountDemo, pageOf, settled, showFolder, sleep } from "./session.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const media = join(here, "..", "src", "media")
const work = join(demoRoot, ".capture")
/** Every screenshot is cut to this size (the window's content at VIEW.scale). */
const SHOT = { width: VIEW.width * VIEW.scale, height: VIEW.height * VIEW.scale }
const VIDEO = { width: 1600, height: 1000, fps: 30 }

const ffmpeg = (args) =>
  execFileSync(process.env.PANELYTH_FFMPEG || "ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ])

const tile = (viewer, name) => viewer.locator(`[data-testid="tile"][aria-label="${name}"]`)
const row = (commander, side, name) =>
  commander.getByTestId(`grid-${side}`).locator("[data-id]", { hasText: name }).first()

/**
 * Gives a page's window the size every capture is taken at. The media window
 * opens full screen, and leaving full screen restores its first size a moment
 * later, so this asks until the page has the size.
 */
async function sized(app, page) {
  for (let i = 0; i < 60; i++) {
    await app.evaluate(({ BrowserWindow }, view) => {
      const [main, ...others] = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)
      for (const win of others) {
        if (win.isFullScreen()) win.setFullScreen(false)
        else if (win.getContentSize()[0] !== view.width) {
          win.setContentSize(view.width, view.height)
          win.setPosition(...main.getPosition())
        }
      }
    }, VIEW)
    // A scaled window rounds to device pixels: a pixel more than asked for is the same size.
    if (await page.evaluate((width) => Math.abs(window.innerWidth - width) <= 2, VIEW.width)) return
    await sleep(100)
  }
  throw new Error("the window did not take the capture size")
}

/**
 * Scrolls the folder tree past the drives of the machine this runs on (their
 * labels are the owner's): it starts at the demo library's drive.
 */
async function treeAtDemoHome(viewer) {
  await viewer.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-testid="tree-node"]')]
    const demo =
      nodes.find((n) => /^U:\\?$/.test(n.textContent.trim())) ??
      nodes.find((n) => n.textContent.trim() === "user")
    demo?.scrollIntoView({ block: "start" })
  })
}

/**
 * The drives of the machine this runs on show in the viewer's folder tree with
 * their volume labels ("Storage (D:)"), which are the owner's: before a
 * picture they read as plain drive letters, as C:\ does. The demo drive (U:)
 * and every folder keep their names.
 */
async function plainDrives(page) {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('[data-testid="tree-node"]')) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const label = /^\s*.+\(([A-Z]):\)\s*$/.exec(text.nodeValue)
        if (label) text.nodeValue = `${label[1]}:\\`
      }
    }
  })
}

/** `--only=a,b` keeps every other picture as it is (the steps still run: each one sets up the next). */
const only = process.argv
  .filter((arg) => arg.startsWith("--only="))
  .flatMap((arg) => arg.slice(7).split(","))

async function still(page, name, pointer = { x: VIEW.width - 6, y: VIEW.height / 2 }) {
  if (only.length > 0 && !only.includes(name)) return
  // Park the pointer where it raises no tooltip and no hover state.
  await page.mouse.move(pointer.x, pointer.y)
  await sleep(700)
  await plainDrives(page)
  const png = join(work, `${name}.png`)
  await page.screenshot({ path: png })
  ffmpeg([
    "-i",
    png,
    "-vf",
    `crop=${SHOT.width}:${SHOT.height}:0:0`,
    "-c:v",
    "libwebp",
    "-quality",
    "90",
    join(media, `${name}.webp`),
  ])
  console.log(`still ${name}`)
}

async function openCommander(app, viewer) {
  await viewer.getByRole("button", { name: "Switch to Commander" }).click()
  const commander = await pageOf(app, "app://commander/index.html")
  await commander.getByTestId("grid-left").locator("[data-id]").first().waitFor()
  return commander
}

/** Navigates a commander panel through its path bar. */
async function goTo(commander, side, path) {
  await commander.getByTestId(`path-${side}`).click()
  const input = commander.getByRole("textbox", { name: "Path" })
  await input.fill(path)
  await input.press("Enter")
  await commander.getByTestId(`path-${side}`).filter({ hasText: path }).waitFor({ timeout: 10_000 })
  await commander.getByTestId(`grid-${side}`).locator("[data-id]").first().waitFor()
}

async function stills(demo) {
  const at = (...parts) => [demo.home, ...parts].join(sep)
  const { app, viewer } = await launch(demo.home)
  try {
    // The viewer: a folder of tiles, one picture selected and in the preview.
    await showFolder(viewer, at("Pictures", "Dolomites 2026"))
    await settled(viewer)
    await tile(viewer, "DSC_4198.jpg").click()
    await viewer.getByTestId("preview-pane").locator("img").first().waitFor()
    await treeAtDemoHome(viewer)
    await sleep(900)
    await still(viewer, "viewer-tiles")

    // One picture in the media window.
    await tile(viewer, "DSC_4207.jpg").dblclick()
    const picture = await pageOf(app, "media.html")
    await picture.getByTestId("image-viewer").waitFor()
    await sized(app, picture)
    await sleep(1800)
    await still(picture, "viewer-photo", { x: VIEW.width / 2, y: VIEW.height - 40 })

    // The editor, with a lighting adjustment under way.
    await picture.getByRole("button", { name: "Edit" }).click()
    await viewer.getByTestId("editor").waitFor()
    await sleep(1200)
    await editSomething(viewer)
    await still(viewer, "viewer-editor", { x: VIEW.width / 2, y: VIEW.height - 20 })
    await viewer.getByTestId("editor-close").click()
    await viewer
      .getByRole("button", { name: /Don.t save/ })
      .click({ timeout: 3000 })
      .catch(() => {})
    await viewer.getByTestId("editor").waitFor({ state: "detached" })

    // The viewer again, in the light theme with large tiles.
    await showFolder(viewer, at("Pictures", "Iceland"))
    // The tile size is the title strip's on Windows, the view bar's elsewhere.
    await viewer.getByLabel("Large tiles", { exact: true }).click()
    await chooseStyle(app, viewer, null, "Light")
    await settled(viewer)
    await tile(viewer, "IMG_2216.jpg").click()
    await treeAtDemoHome(viewer)
    await sleep(900)
    await still(viewer, "viewer-light")
    await chooseStyle(app, viewer, null, "Dark")
    await viewer.getByLabel("Medium tiles", { exact: true }).click()

    // The commander: a marked selection on the left, thumbnails on the right.
    await showFolder(viewer, at("Pictures", "Dolomites 2026"))
    await tile(viewer, "DSC_4186.jpg").click()
    const commander = await openCommander(app, viewer)
    await goTo(commander, "right", at("Pictures", "Lisbon weekend"))
    await commander.getByTestId("grid-right").focus()
    await commander.keyboard.press("Control+Shift+F1")
    await settled(commander, '[data-testid="grid-right"] img')
    await row(commander, "left", "DSC_4186").click()
    for (let i = 0; i < 4; i++) await commander.keyboard.press("Insert")
    for (let i = 0; i < 3; i++) await commander.keyboard.press("ArrowDown")
    await sleep(600)
    await still(commander, "commander-panels", { x: VIEW.width / 2, y: 26 })

    // Quick view: the file under the cursor, in the other panel.
    await commander.keyboard.press("Control+Q")
    await sleep(1800)
    await still(commander, "commander-quick-view", { x: VIEW.width / 2, y: 26 })
    await commander.keyboard.press("Control+Q")

    // Two folders of files side by side, both in the Full view.
    await goTo(commander, "right", at("Pictures", "Sahara"))
    await commander.getByTestId("grid-right").focus()
    await commander.keyboard.press("Control+F2")
    await goTo(commander, "left", at("Pictures", "Iceland"))
    await row(commander, "left", "IMG_2212").click()
    for (let i = 0; i < 5; i++) await commander.keyboard.press("Insert")
    for (let i = 0; i < 2; i++) await commander.keyboard.press("ArrowDown")
    await sleep(600)
    await still(commander, "commander-files", { x: VIEW.width / 2, y: 26 })

    // Find files: the criteria of the Advanced tab, then the results.
    await goTo(commander, "left", at("Pictures"))
    await commander.getByTestId("grid-left").focus()
    await commander.keyboard.press("Alt+F7")
    const find = commander.getByTestId("find-dialog")
    await find.getByLabel("Search for").fill("*.jpg;*.mp4")
    await find.getByRole("tab", { name: "Advanced" }).click()
    await find.getByLabel("Size at least").fill("400")
    await find.getByLabel("Modified from").fill("2026-06-01")
    await find.getByLabel("Modified until").fill("2026-09-30")
    await still(commander, "commander-find", { x: VIEW.width / 2, y: 26 })
    await find.getByRole("button", { name: "Start search" }).click()
    await commander.getByTestId("find-status").filter({ hasText: "Done" }).waitFor()
    await sleep(600)
    await still(commander, "commander-find-results", { x: VIEW.width / 2, y: 26 })
    await commander.keyboard.press("Escape")
    await find.waitFor({ state: "detached" })

    // Multi-rename: a mask with the date and a counter, and the new names previewed.
    await goTo(commander, "left", at("Pictures", "Dolomites 2026"))
    await commander.getByTestId("grid-left").focus()
    await row(commander, "left", "DSC_4180").click()
    for (let i = 0; i < 9; i++) await commander.keyboard.press("Insert")
    await commander.keyboard.press("Control+m")
    const rename = commander.getByTestId("multi-rename-dialog")
    await rename.getByLabel("Name mask").fill("Dolomites [Y]-[M]-[D] [C]")
    await rename
      .getByTestId("rename-preview")
      .getByText(/^Dolomites /)
      .first()
      .waitFor()
    await sleep(500)
    await still(commander, "commander-rename", { x: VIEW.width / 2, y: 26 })
    await commander.keyboard.press("Escape")
    await rename.waitFor({ state: "detached" })

    // The path bar's view options: hidden and system files, the panel's view.
    await commander.getByTestId("view-options-left").click()
    await commander.getByTestId("view-options-menu-left").waitFor()
    await still(commander, "commander-view-options", { x: VIEW.width / 2, y: 26 })
    await commander.keyboard.press("Escape")

    // The Single layout preset: one panel across the window, as thumbnails.
    const presets = commander.getByTestId("title-layout")
    await presets.getByRole("radio", { name: /^Single/ }).click()
    await settled(commander, '[data-testid="grid-left"] img')
    await row(commander, "left", "DSC_4198").click()
    await sleep(700)
    await still(commander, "commander-single", { x: VIEW.width / 2, y: 26 })
    await presets.getByRole("radio", { name: /^Details/ }).click()

    // The command line: earlier commands in its history (Alt+F8), a new one being typed.
    // The history is the capture profile's own, written before the view loads it.
    await commander.evaluate(async (items) => {
      await window.panelyth.library.setSetting("commander.commandHistory", { v: 1, items })
    }, COMMAND_HISTORY)
    // The layout is saved after a quiet moment: a reload before it would bring Single back.
    await sleep(1500)
    await commander.reload()
    await commander.getByTestId("grid-left").locator("[data-id]").first().waitFor()
    await goTo(commander, "left", at("Pictures", "Iceland"))
    await row(commander, "left", "Aurora over Kirkjufell").click()
    const line = commander.getByRole("textbox", { name: "Command line" })
    await line.click()
    await line.pressSequentially('ffmpeg -i "Aurora over Kirkjufell.mp4" -t 8 ', { delay: 10 })
    await commander.keyboard.press("Alt+F8")
    await commander.getByRole("menu", { name: "Command history" }).waitFor()
    await sleep(500)
    await still(commander, "commander-cmdline", { x: VIEW.width / 2, y: 26 })
    await commander.keyboard.press("Escape")
    await line.fill("")
    await commander.getByTestId("grid-left").focus()

    // The text and Markdown editor (F4): notes in Live, the itinerary (a table, a
    // to-do list) in Preview, where tables are drawn, then the PDF export.
    const closeEditors = () =>
      app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows())
          if (w.webContents.getURL().startsWith("app://texteditor/")) w.destroy()
      })
    const openEditor = async (folder, name) => {
      await goTo(commander, "left", at("Documents", folder))
      await row(commander, "left", name).click()
      await commander.keyboard.press("F4")
      const page = await pageOf(app, "app://texteditor/")
      await page.getByTestId("mode-switch").waitFor()
      await sized(app, page)
      await sleep(1200)
      return page
    }
    const corner = { x: VIEW.width - 6, y: VIEW.height - 60 }
    const notes = await openEditor("Notes", "Photo book ideas")
    await still(notes, "editor-live", corner)
    await closeEditors()
    const editor = await openEditor("Trips", "Dolomites itinerary")
    await editor.getByTestId("mode-preview").click()
    await editor.getByTestId("preview").locator("table").waitFor()
    await sleep(600)
    await still(editor, "editor-preview", corner)
    await editor.keyboard.press("Control+Shift+E")
    await editor.getByRole("dialog").waitFor()
    await sleep(500)
    await still(editor, "editor-export", corner)
    await editor.keyboard.press("Escape")
    await closeEditors()

    // The design styles: the viewer in Liquid glass, the commander in Terminal (Phosphor).
    await chooseStyle(app, commander, "Liquid glass")
    await commander.getByRole("button", { name: "Switch to Viewer" }).click()
    await showFolder(viewer, at("Pictures", "Lisbon weekend"))
    await settled(viewer)
    await tile(
      viewer,
      (await viewer.getByTestId("tile").nth(5).getAttribute("aria-label")) ?? "",
    ).click()
    await treeAtDemoHome(viewer)
    await sleep(900)
    await still(viewer, "viewer-glass")
    // The commander in Liquid glass: thumbnails beside a list.
    await viewer.getByRole("button", { name: "Switch to Commander" }).click()
    await goTo(commander, "left", at("Pictures", "Countryside"))
    await goTo(commander, "right", at("Pictures", "Lisbon weekend"))
    await commander.getByTestId("grid-right").focus()
    await commander.keyboard.press("Control+Shift+F1")
    await settled(commander, '[data-testid="grid-right"] img')
    await commander.getByTestId("grid-left").focus()
    await commander.keyboard.press("Control+F2")
    await sleep(900)
    await still(commander, "commander-glass", { x: VIEW.width / 2, y: 26 })
    await commander.getByTestId("grid-right").focus()
    await commander.keyboard.press("Control+F2")
    await commander.getByRole("button", { name: "Switch to Viewer" }).click()
    await chooseStyle(app, viewer, "Terminal", "Phosphor")
    await viewer.getByRole("button", { name: "Switch to Commander" }).click()
    await goTo(commander, "left", at("Pictures", "Iceland"))
    await goTo(commander, "right", at("Pictures", "Sahara"))
    await commander.getByTestId("grid-left").focus()
    await row(commander, "left", "IMG_2212").click()
    for (let i = 0; i < 3; i++) await commander.keyboard.press("Insert")
    await sleep(900)
    await still(commander, "commander-terminal", { x: VIEW.width / 2, y: 26 })
  } finally {
    await app.close().catch(() => {})
  }
}

/** The command line's history in the commander-cmdline shot, newest first. */
const COMMAND_HISTORY = [
  "magick mogrify -resize 2048x2048 -quality 88 *.jpg",
  'exiftool -DateTimeOriginal "IMG_2212.jpg"',
  "git status",
  "cd ..\\Sahara",
  'ffmpeg -i "Dunes at dusk.mp4" -vf scale=1280:-2 dunes-720p.mp4',
  "code .",
]

/** Settings → Appearance: a design style, and the theme by the name the style gives it. */
async function chooseStyle(app, page, style, theme) {
  await page.getByTestId("app-settings").click()
  const settings = await pageOf(app, "/settings.html")
  await settings.getByRole("tab", { name: "Appearance" }).click()
  if (style)
    await settings
      .getByRole("group", { name: "Design style" })
      .getByRole("button", { name: style, exact: true })
      .click()
  if (theme)
    await settings
      .getByRole("group", { name: "Color theme" })
      .getByRole("button", { name: theme, exact: true })
      .click()
  await sleep(400)
  // Esc closes the window on keydown.
  await settings.keyboard.down("Escape")
  for (let i = 0; i < 50 && app.windows().includes(settings); i++) await sleep(50)
  await sleep(500)
}

/** Opens the Lighting panel and moves a few of its controls with the keyboard. */
async function editSomething(viewer) {
  await viewer.getByTestId("tool-panel").getByText("Lighting").click()
  await sleep(500)
  const sliders = viewer.getByTestId("tool-panel").getByRole("slider")
  const count = await sliders.count()
  for (const [index, key, presses] of [
    [0, "ArrowRight", 3], // exposure
    [2, "ArrowRight", 12], // contrast
    [4, "ArrowRight", 16], // shadows
  ]) {
    if (index >= count) continue
    await sliders.nth(index).focus()
    for (let i = 0; i < presses; i++) await viewer.keyboard.press(key)
    await sleep(250)
  }
  // Focusing the controls scrolled the panel: back to the histogram at its top.
  await viewer.getByTestId("editor-panel").evaluate((panel) => {
    for (const el of [panel, ...panel.querySelectorAll("*")]) el.scrollTop = 0
  })
  await sleep(1200)
}

// ------------------------------------------------------------------ video

/**
 * Records the frames a page paints (the DevTools screencast) into one
 * timeline. The app shows one page at a time; `show(page)` says which.
 */
class Recorder {
  frames = []
  active = null
  running = false

  constructor(dir) {
    this.dir = dir
  }

  async attach(page) {
    const cdp = await page.context().newCDPSession(page)
    cdp.on("Page.screencastFrame", (frame) => {
      cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {})
      if (!this.running || this.active !== page) return
      const file = join(this.dir, `${String(this.frames.length).padStart(5, "0")}.jpg`)
      writeFileSync(file, Buffer.from(frame.data, "base64"))
      this.frames.push({
        file,
        at: frame.metadata.timestamp,
        size: `${frame.metadata.deviceWidth}x${frame.metadata.deviceHeight}`,
      })
    })
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 94, everyNthFrame: 1 })
  }

  /** The page on screen from now on. A nudge of the pointer makes it paint a frame. */
  async show(page) {
    this.active = page
    const p = pointers.get(page) ?? { x: VIEW.width / 2, y: VIEW.height / 2 }
    await page.mouse.move(p.x + 1, p.y)
    await page.mouse.move(p.x, p.y)
  }

  /** Writes hero.mp4, hero.webm and the poster from the recorded frames. */
  encode(hold = 0.9) {
    const list = ["ffconcat version 1.0"]
    this.frames.forEach((frame, i) => {
      const next = this.frames[i + 1]
      list.push(`file '${frame.file.replaceAll("\\", "/")}'`)
      list.push(`duration ${(next ? Math.max(0.001, next.at - frame.at) : hold).toFixed(4)}`)
    })
    list.push(`file '${this.frames.at(-1).file.replaceAll("\\", "/")}'`)
    const concat = join(this.dir, "frames.txt")
    writeFileSync(concat, list.join("\n"))
    const filter = `fps=${VIDEO.fps},scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos:force_original_aspect_ratio=increase,crop=${VIDEO.width}:${VIDEO.height}:0:0`
    const input = ["-f", "concat", "-safe", "0", "-i", concat, "-vf", filter, "-an"]
    ffmpeg([
      ...input,
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "25", "-pix_fmt", "yuv420p"],
      ...["-movflags", "+faststart", join(media, "hero.mp4")],
    ])
    ffmpeg([
      ...input,
      ...["-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-row-mt", "1", "-pix_fmt", "yuv420p"],
      join(media, "hero.webm"),
    ])
    ffmpeg([
      ...["-i", this.frames[0].file, "-vf", `scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos`],
      ...["-q:v", "3", join(media, "hero-poster.jpg")],
    ])
  }
}

const pointers = new Map()
/** Where the pointer rests in the viewer: the empty margin beside the tiles, where nothing has a tooltip. */
const REST = { x: VIEW.width * 0.945, y: VIEW.height * 0.55 }

/**
 * A recording shows no system pointer, so each page draws one that follows
 * the mouse, and names the keys that are pressed (the commander is driven
 * from the keyboard, which a silent video would not show otherwise).
 */
async function drawPointer(page) {
  await page.evaluate(() => {
    if (document.getElementById("capture-pointer")) return
    const ns = "http://www.w3.org/2000/svg"
    const svg = document.createElementNS(ns, "svg")
    svg.id = "capture-pointer"
    svg.setAttribute("viewBox", "0 0 24 24")
    const path = document.createElementNS(ns, "path")
    path.setAttribute("d", "M5 2.5v17.2l4.6-4.3 3 6.6 2.6-1.2-3-6.5h6.3z")
    path.setAttribute("fill", "#ffffff")
    path.setAttribute("stroke", "#111111")
    path.setAttribute("stroke-width", "1.3")
    path.setAttribute("stroke-linejoin", "round")
    svg.append(path)
    Object.assign(svg.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "24px",
      height: "24px",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: "translate(-100px, -100px)",
      filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55))",
    })
    const keys = document.createElement("div")
    Object.assign(keys.style, {
      position: "fixed",
      left: "50%",
      bottom: "108px",
      transform: "translateX(-50%)",
      zIndex: "2147483646",
      pointerEvents: "none",
      padding: "9px 18px",
      borderRadius: "10px",
      background: "rgba(12, 13, 10, 0.88)",
      border: "1px solid rgba(255, 255, 255, 0.22)",
      color: "#f2f2ea",
      font: "600 17px ui-sans-serif, system-ui, sans-serif",
      letterSpacing: "0.02em",
      boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
      opacity: "0",
      transition: "opacity 140ms ease",
    })
    document.documentElement.append(svg, keys)
    addEventListener(
      "mousemove",
      (e) => (svg.style.transform = `translate(${e.clientX - 5}px, ${e.clientY - 2}px)`),
      true,
    )
    let timer = 0
    window.__captureKeys = (text) => {
      keys.textContent = text
      keys.style.opacity = "1"
      clearTimeout(timer)
      timer = setTimeout(() => (keys.style.opacity = "0"), 850)
    }
  })
}

/** Moves the pointer along an eased line, as a hand would. */
async function glide(page, x, y, ms = 600) {
  const from = pointers.get(page) ?? { x: VIEW.width * 0.6, y: VIEW.height * 0.55 }
  const steps = Math.max(2, Math.round(ms / 16))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    const started = performance.now()
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e)
    await sleep(Math.max(0, 16 - (performance.now() - started)))
  }
  pointers.set(page, { x, y })
}

async function glideTo(page, locator, ms = 600, where = { x: 0.5, y: 0.5 }) {
  const box = await locator.boundingBox()
  await glide(page, box.x + box.width * where.x, box.y + box.height * where.y, ms)
}

/** Turns the wheel by `distance` pixels over `ms`, eased. */
async function wheel(page, distance, ms) {
  const steps = Math.max(2, Math.round(ms / 16))
  let done = 0
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    const started = performance.now()
    const to = Math.round(distance * e)
    await page.mouse.wheel(0, to - done)
    done = to
    await sleep(Math.max(0, 16 - (performance.now() - started)))
  }
}

/** Presses a key and names it on screen. */
async function press(page, key, label = key, pause = 260) {
  await page.evaluate((text) => window.__captureKeys?.(text), label)
  await page.keyboard.press(key)
  await sleep(pause)
}

async function video(demo) {
  const at = (...parts) => [demo.home, ...parts].join(sep)
  const frames = join(work, "frames")
  rmSync(frames, { recursive: true, force: true })
  mkdirSync(frames, { recursive: true })
  const { app, viewer } = await launch(demo.home)
  try {
    await showFolder(viewer, at("Pictures", "Dolomites 2026"))
    await settled(viewer)
    await treeAtDemoHome(viewer)

    // The commander exists before the recording starts, with its right panel set up.
    const commander = await openCommander(app, viewer)
    await goTo(commander, "right", at("Pictures"))
    // The viewer follows the active panel: make it the left one again, and
    // look at the first pictures once (see the note on the cache below).
    await row(commander, "left", "DSC_4180").click()
    await commander.keyboard.press("Control+Q")
    for (let i = 0; i < 8; i++) {
      await sleep(1100)
      await commander.keyboard.press("ArrowDown")
    }
    await commander.keyboard.press("Control+Q")
    await row(commander, "left", "DSC_4180").click()
    await commander.getByRole("button", { name: "Switch to Viewer" }).click()
    await tile(viewer, "DSC_4198.jpg").waitFor()
    await sleep(600)

    // The recording shows a library that has been looked at before: the
    // pictures it steps through have their previews in the cache. (A first
    // look generates each one, and the media window stays dark meanwhile.)
    await tile(viewer, "DSC_4207.jpg").dblclick()
    const warm = await pageOf(app, "media.html")
    await warm.getByTestId("image-viewer").waitFor()
    for (let i = 0; i < 3; i++) {
      await sleep(1500)
      await warm.keyboard.press("ArrowRight")
    }
    await sleep(1500)
    await warm.keyboard.press("Escape").catch(() => {})
    await warm.waitForEvent("close", { timeout: 5000 }).catch(() => {})
    await viewer.keyboard.press("Escape")
    await wheel(viewer, 2400, 1500)
    await settled(viewer)
    await wheel(viewer, -2400, 600)
    await sleep(500)

    const recorder = new Recorder(frames)
    await drawPointer(viewer)
    await drawPointer(commander)
    await recorder.attach(viewer)
    await recorder.attach(commander)
    await glide(viewer, REST.x, REST.y, 50)
    recorder.running = true
    await recorder.show(viewer)
    await sleep(900)

    // 1. The viewer: scroll the folder, then come back to the top.
    await wheel(viewer, 1500, 2300)
    await sleep(500)
    await wheel(viewer, -1500, 1300)
    await sleep(400)

    // 2. Select two pictures: the preview follows.
    await glideTo(viewer, tile(viewer, "DSC_4198.jpg"), 650, { x: 0.5, y: 0.4 })
    await viewer.mouse.down()
    await viewer.mouse.up()
    await sleep(900)
    await glideTo(viewer, tile(viewer, "DSC_4207.jpg"), 600, { x: 0.5, y: 0.4 })
    await viewer.mouse.down()
    await viewer.mouse.up()
    await sleep(900)

    // 3. Open it; step through the folder in the media window.
    await viewer.mouse.dblclick(pointers.get(viewer).x, pointers.get(viewer).y)
    const picture = await pageOf(app, "media.html")
    await picture.getByTestId("image-viewer").waitFor()
    await sized(app, picture)
    await drawPointer(picture)
    await recorder.attach(picture)
    pointers.set(picture, { x: VIEW.width * 0.6, y: VIEW.height * 0.7 })
    await recorder.show(picture)
    await sleep(1300)
    await press(picture, "ArrowRight", "→", 1000)
    await press(picture, "ArrowRight", "→", 1000)
    await press(picture, "ArrowRight", "→", 1100)
    await picture.evaluate(() => window.__captureKeys?.("Esc"))
    await sleep(250)
    recorder.active = null
    await picture.keyboard.press("Escape").catch(() => {})
    await sleep(350)
    await recorder.show(viewer)
    await sleep(500)

    // 4. Switch to the commander, which shows the same folder.
    await glideTo(viewer, viewer.getByRole("button", { name: "Switch to Commander" }), 800)
    await sleep(200)
    recorder.active = null
    await viewer.mouse.down()
    await viewer.mouse.up()
    pointers.set(commander, { ...pointers.get(viewer) })
    await commander.getByTestId("grid-left").locator("[data-cursor=true]").waitFor()
    await recorder.show(commander)
    await sleep(900)
    await glide(commander, VIEW.width * 0.78, VIEW.height * 0.7, 500)

    // 5. Mark a few files, look at them in the quick view, and copy them across.
    await commander.getByTestId("grid-left").focus()
    for (let i = 0; i < 4; i++) await press(commander, "Insert", "Insert", 240)
    await sleep(300)
    await press(commander, "Control+Q", "Ctrl + Q", 1100)
    for (let i = 0; i < 4; i++) await press(commander, "ArrowDown", "↓", 620)
    await press(commander, "Control+Q", "Ctrl + Q", 700)
    await press(commander, "Tab", "Tab", 500)
    await press(commander, "Tab", "Tab", 500)

    // 6. And back to the viewer.
    await glideTo(commander, commander.getByRole("button", { name: "Switch to Viewer" }), 800)
    await sleep(200)
    recorder.active = null
    await commander.mouse.down()
    await commander.mouse.up()
    pointers.set(viewer, { ...pointers.get(commander) })
    await sleep(250)
    await recorder.show(viewer)
    await glide(viewer, REST.x, REST.y, 700)
    await sleep(700)
    recorder.running = false

    const sizes = [...new Set(recorder.frames.map((f) => f.size))]
    const seconds = recorder.frames.at(-1).at - recorder.frames[0].at
    console.log(`video: ${recorder.frames.length} frames, ${seconds.toFixed(1)} s, ${sizes}`)
    recorder.encode()
  } finally {
    await app.close().catch(() => {})
  }
}

const jobs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
const wanted = (job) => jobs.length === 0 || jobs.includes(job)
mkdirSync(media, { recursive: true })
mkdirSync(work, { recursive: true })
const demo = mountDemo()
try {
  if (wanted("stills")) await stills(demo)
  if (wanted("video")) await video(demo)
} finally {
  demo.unmount()
}
