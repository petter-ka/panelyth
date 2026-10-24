import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import brandMark from "./media/mark.svg"
import shotCmdline from "./media/commander-cmdline.webp"
import shotFiles from "./media/commander-files.webp"
import shotFindResults from "./media/commander-find-results.webp"
import shotFind from "./media/commander-find.webp"
import shotCommanderGlass from "./media/commander-glass.webp"
import shotCommander from "./media/commander-panels.webp"
import shotQuickView from "./media/commander-quick-view.webp"
import shotRename from "./media/commander-rename.webp"
import shotSingle from "./media/commander-single.webp"
import shotTerminal from "./media/commander-terminal.webp"
import shotViewOptions from "./media/commander-view-options.webp"
import shotEditorExport from "./media/editor-export.webp"
import shotEditorLive from "./media/editor-live.webp"
import shotEditorPreview from "./media/editor-preview.webp"
import shotEditor from "./media/viewer-editor.webp"
import shotViewerGlass from "./media/viewer-glass.webp"
import shotLight from "./media/viewer-light.webp"
import shotPhoto from "./media/viewer-photo.webp"
import shotTiles from "./media/viewer-tiles.webp"

const REPO = "petter-ka/panelyth"
const GITHUB = `https://github.com/${REPO}`
const RELEASES = `${GITHUB}/releases`
const LATEST = `${RELEASES}/latest`
const INSTALL_GUIDE = `${GITHUB}/blob/main/docs/INSTALL.md`
const LICENSE = `${GITHUB}/blob/main/LICENSE`

/** The window's content size the screenshots were taken at. */
const FRAME = { width: 2160, height: 1350 }

const Arrow = ({ diagonal = false, down = false, back = false }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 20 20"
    className={`arrow${diagonal ? " arrow-diagonal" : ""}${down ? " arrow-down" : ""}${back ? " arrow-back" : ""}`}
  >
    <path d={diagonal ? "M5 15 15 5M6 5h9v9" : "M3.5 10h12M10 4.5l5.5 5.5-5.5 5.5"} />
  </svg>
)

/** The app icon's mark in its small drawing (scripts/icons.mjs writes media/mark.svg). */
const BrandMark = () => <img className="brand-mark" src={brandMark} alt="" />

const principles = [
  {
    title: "Keys you already know",
    copy: "Tab between the panels, F5 to copy, F6 to move, Insert to mark. The keyboard model follows Total Commander, and every shortcut can be remapped.",
  },
  {
    title: "An interface for today",
    copy: "One design system across both apps, in three styles (classic, liquid glass and a terminal) and light and dark themes, at the interface size you choose, in eight languages.",
  },
  {
    title: "Nothing waits",
    copy: "Scrolling and the cursor never wait for thumbnails, listings or a running copy. Long work goes to a background queue you can watch, pause and cancel.",
  },
]

const functionKeys = [
  ["F3", "View"],
  ["F4", "Edit"],
  ["F5", "Copy"],
  ["F6", "Move"],
  ["F7", "New folder"],
  ["F8", "Delete"],
]

const shared = [
  {
    value: "4–6 ms",
    label: "to switch between the two apps, once both are open",
  },
  {
    value: "100k",
    label: "entries in one folder is the size both apps are budgeted and tested for",
  },
  {
    value: "0",
    label: "accounts, uploads or cloud services. Everything runs on your computer",
  },
  {
    value: "8",
    label: "interface languages, with a light and a dark theme",
  },
]

/** Every screenshot, by name. `label` and `title` caption it in the gallery. */
const SHOTS = {
  tiles: {
    src: shotTiles,
    label: "VIEWER / TILES",
    title: "A folder at a glance, with the preview beside it.",
    alt: "The Panelyth viewer showing a folder of landscape photographs as tiles, with the folder tree and a preview of the selected picture on the left",
  },
  photo: {
    src: shotPhoto,
    label: "VIEWER / PICTURE",
    title: "One picture, the whole window.",
    alt: "A single photograph opened in Panelyth's media window",
  },
  editor: {
    src: shotEditor,
    label: "VIEWER / EDITOR",
    title: "Adjust, retouch and save a copy.",
    alt: "Panelyth's image editor with the Lighting tool open beside a photograph",
  },
  light: {
    src: shotLight,
    label: "VIEWER / LIGHT THEME",
    title: "Large tiles, in the light theme.",
    alt: "The Panelyth viewer in the light theme, showing a folder of photographs as large tiles with the filter bar above them",
  },
  viewerGlass: {
    src: shotViewerGlass,
    label: "VIEWER / LIQUID GLASS",
    title: "Translucent panels over a soft wallpaper.",
    alt: "The Panelyth viewer in the Liquid glass style: rounded, translucent panels floating over a soft background, a folder of city and beach photographs as tiles",
  },
  commander: {
    src: shotCommander,
    label: "COMMANDER / PANELS",
    title: "Two folders, side by side.",
    alt: "Panelyth Commander with a file list on the left, thumbnails on the right and the function-key bar",
  },
  files: {
    src: shotFiles,
    label: "COMMANDER / TWO PANELS",
    title: "Files on the left, files on the right, marks in between.",
    alt: "Panelyth Commander with two folders of files in the Full view, five files marked in the left panel",
  },
  quickView: {
    src: shotQuickView,
    label: "COMMANDER / QUICK VIEW",
    title: "The file under the cursor, in the other panel.",
    alt: "Panelyth Commander showing a quick view of a picture in the right panel",
  },
  find: {
    src: shotFind,
    label: "COMMANDER / FIND FILES",
    title: "Search by size, date and attributes.",
    alt: "The Find files dialog of Panelyth Commander on its Advanced tab, with a minimum size and a date range filled in",
  },
  findResults: {
    src: shotFindResults,
    label: "COMMANDER / SEARCH RESULTS",
    title: "Go to a result, or feed them all to a panel.",
    alt: "The Find files dialog listing its results with their folders and sizes",
  },
  rename: {
    src: shotRename,
    label: "COMMANDER / MULTI-RENAME",
    title: "Nine files renamed by date and counter, previewed first.",
    alt: "The Multi-rename dialog with the mask 'Dolomites [Y]-[M]-[D] [C]' and a preview of nine new names",
  },
  single: {
    src: shotSingle,
    label: "COMMANDER / SINGLE LAYOUT",
    title: "One panel across the window, as thumbnails.",
    alt: "Panelyth Commander in the Single layout: one panel filling the window with a folder of photographs as thumbnails, nine of them marked",
  },
  viewOptions: {
    src: shotViewOptions,
    label: "COMMANDER / VIEW OPTIONS",
    title: "Hidden files and the panel's view, from the path bar.",
    alt: "The view options menu open from the eye button of the commander's path bar, with the Show and View groups",
  },
  cmdline: {
    src: shotCmdline,
    label: "COMMANDER / COMMAND LINE",
    title: "The commands you ran before, a key away.",
    alt: "The commander's command line with a command being typed and its history of earlier commands open above it",
  },
  commanderGlass: {
    src: shotCommanderGlass,
    label: "COMMANDER / LIQUID GLASS",
    title: "A list and thumbnails, in Liquid glass.",
    alt: "Panelyth Commander in the Liquid glass style, a file list on the left and thumbnails on the right in translucent panels",
  },
  terminal: {
    src: shotTerminal,
    label: "COMMANDER / TERMINAL",
    title: "The Terminal style, in Phosphor.",
    alt: "Panelyth Commander in the Terminal style: green monospaced text on black, panels framed with corner brackets",
  },
  editorLive: {
    src: shotEditorLive,
    label: "EDITOR / LIVE",
    title: "Markdown that looks finished while you type.",
    alt: "The text editor window in Live mode, a Markdown note with a heading and a numbered list",
  },
  editorPreview: {
    src: shotEditorPreview,
    label: "EDITOR / PREVIEW",
    title: "Tables and task lists, drawn.",
    alt: "The text editor window in Preview mode, showing a trip itinerary with a table and a to-do list",
  },
  editorExport: {
    src: shotEditorExport,
    label: "EDITOR / EXPORT PDF",
    title: "A clean PDF: A4 or Letter, three margins.",
    alt: "The Export PDF dialog of the text editor, with the page size and margins to choose",
  },
}

const viewerFeatures = [
  {
    title: "Tiles for very large folders",
    copy: "Small, medium or large tiles that reflow with the window. Only what is on screen is drawn, so a folder of 100,000 pictures scrolls like a folder of a hundred.",
    shot: SHOTS.tiles,
  },
  {
    title: "A closer look",
    copy: "Zoom and pan a still, play local video, and step through the folder with the arrow keys or the wheel. Thumbnails are cached, so a second visit is immediate.",
    shot: SHOTS.photo,
  },
  {
    title: "Search, sort and filter",
    copy: "Find a file by name, sort by name, date, size or type, filter by type, rating or tag, and keep bookmarks and recent folders in the sidebar next to the folder tree.",
    shot: SHOTS.light,
  },
  {
    title: "An editor built in",
    copy: "Crop and straighten, adjust light and color with levels and curves, add borders and watermarks, retouch. Save the steps as a recipe and run it over a whole folder.",
    shot: SHOTS.editor,
  },
]

const commanderFeatures = [
  {
    title: "Three views per panel",
    copy: "Full with sortable, resizable columns, Brief with names in columns, and Thumbnails. Tabs in each panel, and tab sets you can save.",
    shot: SHOTS.commander,
  },
  {
    title: "Find, compare, synchronize",
    copy: "Find files by name, content, size or date. Compare two folders and synchronize them, compare files line by line, create and verify checksums.",
    shot: SHOTS.findResults,
  },
  {
    title: "Rename many at once",
    copy: "A multi-rename tool with counters, dates, search and replace and a preview of every new name, plus undo for the last run.",
    shot: SHOTS.rename,
  },
  {
    title: "Quick view and lister",
    copy: "See the file under the cursor in the other panel, or open text, hex, pictures and video in the lister with F3.",
    shot: SHOTS.quickView,
  },
  {
    title: "A queue for the heavy work",
    copy: "Copy, move and delete run in the background with progress, pause and a clear dialog for conflicts. Both panels stay usable throughout.",
  },
  {
    title: "Archives and servers as folders",
    copy: "Enter a zip or tar archive as you would a folder, pack and unpack, and connect to FTP and FTPS servers with saved connections.",
  },
]

/** The newest work, each with its pictures: the first is the large one. */
const newFeatures = [
  {
    eyebrow: "TEXT AND MARKDOWN EDITOR",
    title: "Notes and Markdown, right next to your files.",
    copy: "F4 opens text, code and Markdown in an editor window of its own, and saving puts the file back whole, never half written.",
    points: [
      "Three ways to see Markdown: Live looks like the finished page while you type, Preview draws tables and task lists, Source shows every character.",
      "Find and replace, word count, and code and config files with their colours.",
      "Drop a picture in or paste a screenshot: it is saved next to the note.",
      "Export a clean PDF on white paper, A4 or Letter, with page numbers.",
    ],
    shots: [SHOTS.editorPreview, SHOTS.editorLive, SHOTS.editorExport],
    window: "Dolomites itinerary.md",
  },
  {
    eyebrow: "DESIGN STYLES",
    title: "Three styles. The same app.",
    copy: "Choose the look in Settings; both apps follow at once, and every theme works in every style.",
    points: [
      "Classic: flat, neutral panels, so photos are judged on a quiet surround.",
      "Liquid glass: rounded, translucent panels over a soft wallpaper drawn from the theme's colours.",
      "Terminal: a field operative's console with framed panels and monospaced type, where the themes become Phosphor, Ice, Amber and three paper dossiers.",
    ],
    shots: [SHOTS.terminal, SHOTS.viewerGlass, SHOTS.commanderGlass],
    window: "Panelyth — Commander",
  },
  {
    eyebrow: "LAYOUT PRESETS",
    title: "One click sets the whole window.",
    copy: "The commander's title bar holds layout presets that set both panels together, instead of changing one panel at a time.",
    points: [
      "Details, List, Tree, Gallery, Preview and Stacked, one above the other.",
      "Single: the active panel alone across the window, as thumbnails; Tab brings up the other one.",
      "The preset that matches the window stays lit; change something by hand and none is.",
    ],
    shots: [SHOTS.single],
    window: "Panelyth — Commander",
  },
  {
    eyebrow: "PANELS YOUR WAY",
    title: "Panels that read the way you do.",
    copy: "The eye in the path bar holds what a panel shows and how, and the panel settings follow how people sort and read.",
    points: [
      "Show hidden and system files, and switch the panel between Full, Brief and Thumbnails.",
      "Folders stay in name order while you sort the files by size or date.",
      'Recent dates in words, "yesterday at 14:05", with the system\'s format or ISO for older ones.',
    ],
    shots: [SHOTS.viewOptions],
    window: "Panelyth — Commander",
  },
  {
    eyebrow: "COMMAND LINE",
    title: "A command line that remembers.",
    copy: "Type a command for the folder you are in, as you would in a terminal opened there.",
    points: [
      "Enter runs it; Shift+Enter runs it in a console window.",
      "Alt+F8 brings back the commands you ran before.",
      "cd moves the panel to another folder, without leaving the keyboard.",
    ],
    shots: [SHOTS.cmdline],
    window: "Panelyth — Commander",
  },
]

/** The hero's slides: the commander and the viewer in turn, the new work among them. */
const heroSlides = [
  SHOTS.files,
  SHOTS.tiles,
  SHOTS.terminal,
  SHOTS.viewerGlass,
  SHOTS.editorPreview,
  SHOTS.single,
  SHOTS.editor,
]
/** The app a screenshot shows, from its label ("VIEWER / TILES"). */
const windowName = (label) =>
  label.startsWith("VIEWER") ? "Viewer" : label.startsWith("EDITOR") ? "Editor" : "Commander"

/** How long the hero shows one slide. */
const SLIDE_MS = 5000

/** The gallery: what the sections above do not show large, two of them across the grid. */
const gallery = [
  { ...SHOTS.files, span: true },
  SHOTS.find,
  SHOTS.commanderGlass,
  SHOTS.editorLive,
  SHOTS.editorExport,
  { ...SHOTS.viewerGlass, span: true },
  SHOTS.photo,
  SHOTS.light,
]

const platforms = [
  {
    id: "windows",
    name: "Windows",
    requirement: "Windows 10 or 11, 64-bit",
    note: "Installs for your account, without administrator rights.",
    files: [{ label: "Installer (.exe)", suffix: "-win-x64.exe" }],
  },
  {
    id: "macos",
    name: "macOS",
    requirement: "Apple silicon or Intel",
    note: "Open the disk image and drag Panelyth to Applications.",
    files: [
      { label: "Apple silicon (.dmg)", suffix: "-mac-arm64.dmg" },
      { label: "Intel (.dmg)", suffix: "-mac-x64.dmg" },
    ],
  },
  {
    id: "linux",
    name: "Linux",
    requirement: "64-bit",
    note: "The AppImage needs FUSE 2 (libfuse2); the archive runs from any folder.",
    files: [
      { label: "AppImage", suffix: "-linux-x86_64.AppImage" },
      { label: "Archive (.tar.gz)", suffix: "-linux-x64.tar.gz" },
    ],
  },
]

function currentPlatform() {
  const name = (navigator.userAgentData?.platform ?? navigator.platform ?? "").toLowerCase()
  if (name.includes("win")) return "windows"
  if (name.includes("mac")) return "macos"
  if (name.includes("linux")) return "linux"
  return null
}

const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`

/**
 * The newest published release, from GitHub. Until one is published (or when
 * GitHub cannot be reached) the page links to the releases page instead.
 */
function useLatestRelease() {
  const [release, setRelease] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.tag_name) return
        setRelease({
          version: data.tag_name.replace(/^v/, ""),
          url: data.html_url,
          date: data.published_at?.slice(0, 10) ?? "",
          assets: (data.assets ?? []).map((a) => ({
            name: a.name,
            url: a.browser_download_url,
            size: a.size,
          })),
        })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])
  return release
}

function AppWindow({ title, children }) {
  return (
    <div className="app-window">
      <div className="app-window-bar" aria-hidden="true">
        <div className="app-window-dots">
          <i />
          <i />
          <i />
        </div>
        <span>{title}</span>
      </div>
      {children}
    </div>
  )
}

function HeroSlideshow() {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  // The slides wait while the pointer or the keyboard focus is on them.
  const [held, setHeld] = useState(false)
  const count = heroSlides.length
  const slide = heroSlides[index]

  useEffect(() => {
    // People who asked for less motion change the slides themselves.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setPlaying(false)
  }, [])

  useEffect(() => {
    if (!playing || held) return undefined
    const timer = setTimeout(() => setIndex((i) => (i + 1) % count), SLIDE_MS)
    return () => clearTimeout(timer)
  }, [index, playing, held, count])

  const step = (by) => setIndex((i) => (i + by + count) % count)

  return (
    <section
      className="hero-visual"
      aria-roledescription="carousel"
      aria-label="Screenshots of the Panelyth viewer and commander"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <AppWindow title={`Panelyth — ${windowName(slide.label)}`}>
        <div className="hero-slides" aria-live={playing ? "off" : "polite"}>
          {heroSlides.map((shot, i) => (
            <img
              key={shot.label}
              className={i === index ? "hero-slide is-current" : "hero-slide"}
              src={shot.src}
              alt={i === index ? shot.alt : ""}
              aria-hidden={i !== index}
              width={FRAME.width}
              height={FRAME.height}
              loading={i === 0 ? "eager" : "lazy"}
              decoding="async"
            />
          ))}
        </div>
      </AppWindow>
      <div className="visual-caption">
        <span className="slide-caption">
          <b>{slide.label}</b> {slide.title}
        </span>
        <div className="slide-controls">
          <button
            type="button"
            className="slide-step"
            aria-label="Previous slide"
            onClick={() => step(-1)}
          >
            <Arrow back />
          </button>
          <div className="slide-dots">
            {heroSlides.map((shot, i) => (
              <button
                key={shot.label}
                type="button"
                className={i === index ? "slide-dot is-current" : "slide-dot"}
                aria-label={`Slide ${i + 1} of ${count}: ${shot.title}`}
                aria-current={i === index}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
          <button
            type="button"
            className="slide-step"
            aria-label="Next slide"
            onClick={() => step(1)}
          >
            <Arrow />
          </button>
          <button type="button" className="slide-toggle" onClick={() => setPlaying(!playing)}>
            {playing ? "Pause" : "Play"}
          </button>
        </div>
      </div>
    </section>
  )
}

/** An app's features as cards: a screenshot above the ones that have one. */
function FeatureCards({ items }) {
  return (
    <ul className="feature-cards">
      {items.map((item, index) => (
        <li key={item.title} className={item.shot ? "feature-card" : "feature-card is-text"}>
          {item.shot && <Screenshot shot={item.shot} />}
          <div className="feature-card-body">
            <span className="feature-number">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h3>{item.title}</h3>
              <p>{item.copy}</p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** One piece of new work: its pictures beside what it does. */
function NewFeature({ feature, index }) {
  const [main, ...more] = feature.shots
  return (
    <article className="new-block">
      <div className="new-media">
        <AppWindow title={feature.window}>
          <Screenshot shot={main} />
        </AppWindow>
        {more.length > 0 && (
          <div className="new-thumbs">
            {more.map((shot) => (
              <figure key={shot.label}>
                <Screenshot shot={shot} />
                <figcaption>{shot.title}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
      <div className="new-copy">
        <span className="new-eyebrow">
          {String(index + 1).padStart(2, "0")} · {feature.eyebrow}
        </span>
        <h3>{feature.title}</h3>
        <p>{feature.copy}</p>
        <ul>
          {feature.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </div>
    </article>
  )
}

function Screenshot({ shot, eager = false }) {
  return (
    <a className="shot-link" href={shot.src} target="_blank" rel="noreferrer">
      <img
        src={shot.src}
        alt={shot.alt}
        width={FRAME.width}
        height={FRAME.height}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
      />
    </a>
  )
}

function Download({ release }) {
  const [mine, setMine] = useState(null)
  useEffect(() => setMine(currentPlatform()), [])
  const asset = (suffix) => release?.assets.find((a) => a.name.endsWith(suffix))
  const checksums = release?.assets.find((a) => a.name === "SHA256SUMS.txt")

  return (
    <section className="download-section" id="download">
      <div className="section-topline">
        <span>08 / DOWNLOAD</span>
        <span>
          {release ? `VERSION ${release.version} · ${release.date}` : "WINDOWS · macOS · LINUX"}{" "}
          <i>✳</i>
        </span>
      </div>
      <div className="section-heading">
        <h2>
          Get
          <br />
          <em>Panelyth.</em>
        </h2>
        <p>
          One download brings both apps. Releases are published on GitHub, with a checksum for every
          file, and the app updates itself from Settings → About when you ask it to.
        </p>
      </div>
      <div className="platform-grid">
        {platforms.map((platform) => (
          <article
            className={platform.id === mine ? "platform is-mine" : "platform"}
            key={platform.id}
          >
            <div className="platform-head">
              <h3>{platform.name}</h3>
              {platform.id === mine && <span>YOUR SYSTEM</span>}
            </div>
            <p className="platform-requirement">{platform.requirement}</p>
            <ul>
              {platform.files.map((file) => {
                const found = asset(file.suffix)
                return (
                  <li key={file.suffix}>
                    <a href={found?.url ?? LATEST} className="download-link">
                      <span>{file.label}</span>
                      <small>{found ? megabytes(found.size) : "Latest release"}</small>
                      <Arrow down />
                    </a>
                  </li>
                )
              })}
            </ul>
            <p className="platform-note">{platform.note}</p>
          </article>
        ))}
      </div>
      <div className="download-foot">
        <a href={release?.url ?? RELEASES}>
          {release ? `Release notes for ${release.version}` : "All releases"} <Arrow diagonal />
        </a>
        <a href={checksums?.url ?? LATEST}>
          SHA256SUMS.txt <Arrow diagonal />
        </a>
        <a href={INSTALL_GUIDE}>
          Install, update and remove <Arrow diagonal />
        </a>
        <a href={GITHUB}>
          Source on GitHub <Arrow diagonal />
        </a>
      </div>
      <p className="download-smallprint">
        A build that is not yet signed is announced by the system on first start: on Windows choose
        More info → Run anyway; on macOS right-click Panelyth in Applications and choose Open.
        Videos on macOS need ffmpeg installed, and 7z and RAR archives need 7-Zip; the install guide
        has the details.
      </p>
    </section>
  )
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)
  const release = useLatestRelease()

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Panelyth home" onClick={closeMenu}>
          <BrandMark />
          <span>panelyth</span>
        </a>
        <button
          className="menu-toggle"
          type="button"
          aria-expanded={menuOpen}
          aria-controls="site-nav"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <span>{menuOpen ? "Close" : "Menu"}</span>
          <i className={menuOpen ? "menu-icon is-open" : "menu-icon"}>
            <b />
            <b />
          </i>
        </button>
        <nav
          className={menuOpen ? "site-nav is-open" : "site-nav"}
          id="site-nav"
          aria-label="Main navigation"
        >
          <a href="#why" onClick={closeMenu}>
            Why
          </a>
          <a href="#new" onClick={closeMenu}>
            What&apos;s new
          </a>
          <a href="#viewer" onClick={closeMenu}>
            Viewer
          </a>
          <a href="#commander" onClick={closeMenu}>
            Commander
          </a>
          <a href="#screenshots" onClick={closeMenu}>
            Screenshots
          </a>
          <a href={GITHUB} onClick={closeMenu}>
            GitHub
          </a>
        </nav>
        <a className="header-cta" href="#download" onClick={closeMenu}>
          Download <Arrow down />
        </a>
      </header>

      <main>
        <section className="hero" id="top">
          <div className="hero-heading">
            <div className="section-label">
              <span>01</span>
              <i /> PANELYTH · VIEWER + COMMANDER
            </div>
            <h1>
              Every file,
              <br />
              <em>in clear view.</em>
            </h1>
            <div className="hero-intro">
              <p>
                An open-source photo and video browser and a two-panel file manager, sharing one
                window. Quick with very large folders, calm to look at, and entirely on your own
                computer.
              </p>
              <div className="hero-actions">
                <a className="button button-primary" href="#download">
                  Download{release ? ` ${release.version}` : ""} <Arrow down />
                </a>
                <a className="button" href={GITHUB}>
                  View on GitHub <Arrow diagonal />
                </a>
              </div>
            </div>
            <div className="platform-line">
              <span>WINDOWS</span>
              <i /> <span>macOS</span>
              <i /> <span>LINUX</span>
              <b>OPEN SOURCE · LOCAL FIRST · NO ACCOUNT</b>
            </div>
          </div>
          <HeroSlideshow />
        </section>

        <section className="why-section" id="why">
          <div className="section-topline">
            <span>02 / WHY PANELYTH</span>
            <span>
              A FAMILIAR WAY OF WORKING <i>✳</i>
            </span>
          </div>
          <div className="why-content">
            <h2>
              A classic idea,
              <br />
              <em>carried forward.</em>
            </h2>
            <div className="why-copy">
              <p>
                Two-panel file managers are still one of the quickest ways to work with files, and
                Total Commander has set the standard for them for more than thirty years. Panelyth
                began with respect for that way of working, and a wish to have it in an interface
                made for today&apos;s screens and today&apos;s folder sizes.
              </p>
              <p>
                So the Commander keeps the keys many hands already know and pairs them with a
                current design, lists that stay smooth at a hundred thousand entries, and file
                operations that run in a visible background queue.
              </p>
              <p>
                The other half of the idea is a media browser that earns its place. Photos and
                videos get an app of their own, the Viewer, and the two share one window, so you
                never have to choose between managing your files and looking at them.
              </p>
            </div>
          </div>
          <div className="principle-grid">
            {principles.map((item, index) => (
              <article className="principle" key={item.title}>
                <div className="principle-number">
                  0{index + 1}
                  <span> / 03</span>
                </div>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="new-section" id="new">
          <div className="section-topline">
            <span>03 / WHAT&apos;S NEW</span>
            <span>
              EDITOR · STYLES · LAYOUTS <i>✳</i>
            </span>
          </div>
          <div className="section-heading">
            <h2>
              New in
              <br />
              <em>Panelyth.</em>
            </h2>
            <p>
              A text and Markdown editor, three design styles, layouts that set the whole window,
              and panels and a command line that work the way you do.
            </p>
          </div>
          <div className="new-list">
            {newFeatures.map((feature, index) => (
              <NewFeature key={feature.eyebrow} feature={feature} index={index} />
            ))}
          </div>
        </section>

        <section className="app-section" id="viewer">
          <div className="section-topline">
            <span>04 / VIEWER</span>
            <span>
              PHOTOS AND VIDEO <i>✳</i>
            </span>
          </div>
          <div className="section-heading">
            <h2>
              Photos and video,
              <br />
              <em>without the wait.</em>
            </h2>
            <p>
              Open a folder and start browsing straight away. Thumbnails arrive as you scroll, and
              the picture you select is already in the preview.
            </p>
          </div>
          <FeatureCards items={viewerFeatures} />
        </section>

        <section className="app-section app-section-alt" id="commander">
          <div className="section-topline">
            <span>05 / COMMANDER</span>
            <span>
              TWO-PANEL FILE MANAGER <i>✳</i>
            </span>
          </div>
          <div className="section-heading">
            <h2>
              Two panels.
              <br />
              <em>Hands on the keys.</em>
            </h2>
            <p>
              Two folders side by side and every operation a key press away. Nothing happens to a
              file without an explicit command, and nothing blocks while it runs.
            </p>
          </div>
          <FeatureCards items={commanderFeatures} />
          <div className="key-bar" aria-label="The function keys of the commander">
            {functionKeys.map(([key, action]) => (
              <span key={key}>
                <kbd>{key}</kbd> {action}
              </span>
            ))}
          </div>
        </section>

        <section className="together-section" id="together">
          <div className="section-topline">
            <span>06 / ONE WINDOW</span>
            <span>
              SHARED STATE <i>✳</i>
            </span>
          </div>
          <div className="section-heading">
            <h2>
              Switch apps,
              <br />
              <em>keep your place.</em>
            </h2>
            <p>
              <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>M</kbd> or the rail on the left moves between
              the Viewer and the Commander. The other app opens in the folder you are in, and what
              you selected comes with you. Bookmarks, recent folders and appearance are shared too.
            </p>
          </div>
          <dl className="stat-grid">
            {shared.map((item) => (
              <div className="stat" key={item.value}>
                <dt>{item.value}</dt>
                <dd>{item.label}</dd>
              </div>
            ))}
          </dl>
          <p className="stat-note">
            The switch time was measured on the project&apos;s reference machine; the first switch,
            which creates the second app, took 92 ms there.
          </p>
        </section>

        <section className="screenshots-section" id="screenshots">
          <div className="section-topline">
            <span>07 / IN THE APP</span>
            <span>
              SCREENSHOTS <i>✳</i>
            </span>
          </div>
          <div className="section-heading">
            <h2>
              A look
              <br />
              <em>inside.</em>
            </h2>
            <p>
              Taken from the app itself, on a library of generated pictures. Select a screenshot to
              open it at full size.
            </p>
          </div>
          <div className="shot-grid">
            {gallery.map((shot) => (
              <figure
                className={shot.span ? "shot-card shot-card-wide" : "shot-card"}
                key={shot.label}
              >
                <Screenshot shot={shot} />
                <figcaption>
                  <span>{shot.label}</span>
                  <b>{shot.title}</b>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <Download release={release} />

        <section className="about-section" id="about">
          <div className="section-topline">
            <span>09 / ABOUT</span>
            <span>LOCAL FILES · CLEAR WORKFLOW</span>
          </div>
          <div className="about-content">
            <div className="about-copy">
              <h2>
                Your files.
                <br />
                <em>Your machine.</em>
              </h2>
              <p>
                Panelyth needs no account and no network to browse, preview, play or manage your
                files. Thumbnails live in your system&apos;s cache folder, never beside your
                pictures, and can be deleted at any time; settings, bookmarks and tags are kept
                across updates. It is open source under the MIT License, so you can read the code,
                build it yourself and change it.
              </p>
              <div className="about-links">
                <a href={GITHUB}>
                  Repository <Arrow diagonal />
                </a>
                <a href={RELEASES}>
                  Releases <Arrow diagonal />
                </a>
                <a href={`${GITHUB}/issues`}>
                  Issues and ideas <Arrow diagonal />
                </a>
                <a href={LICENSE}>
                  MIT License <Arrow diagonal />
                </a>
              </div>
            </div>
            <div className="stack-card">
              <div className="stack-card-head">
                <span>HOW IT IS BUILT</span>
                <span>01 — 03</span>
              </div>
              <div className="stack-row">
                <span>01</span>
                <b>React</b>
                <small>Both interfaces, virtualized</small>
              </div>
              <div className="stack-row">
                <span>02</span>
                <b>Electron</b>
                <small>One shell, one window</small>
              </div>
              <div className="stack-row">
                <span>03</span>
                <b>Go</b>
                <small>Index, previews, file operations</small>
              </div>
              <div className="stack-card-foot">
                <i /> LOCAL FIRST <span>BUILT FOR DESKTOP</span>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <a className="brand footer-brand" href="#top">
          <BrandMark />
          <span>panelyth</span>
        </a>
        <span className="footer-note">A VIEWER AND A COMMANDER, IN ONE WINDOW.</span>
        <a className="footer-top" href={GITHUB}>
          GITHUB <span>↗</span>
        </a>
        <a className="footer-top footer-top-plain" href="#top">
          BACK TO TOP <span>↑</span>
        </a>
        <span className="footer-copy">© 2026 PANELYTH · OPEN SOURCE, MIT</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById("root")).render(<App />)
