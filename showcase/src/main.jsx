import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import shotFiles from "./media/commander-files.webp"
import shotFindResults from "./media/commander-find-results.webp"
import shotFind from "./media/commander-find.webp"
import shotCommander from "./media/commander-panels.webp"
import shotQuickView from "./media/commander-quick-view.webp"
import shotEditor from "./media/viewer-editor.webp"
import shotLight from "./media/viewer-light.webp"
import shotPhoto from "./media/viewer-photo.webp"
import shotTiles from "./media/viewer-tiles.webp"

const REPO = "petter-ka/panelyth"
const GITHUB = `https://github.com/${REPO}`
const RELEASES = `${GITHUB}/releases`
const LATEST = `${RELEASES}/latest`
const INSTALL_GUIDE = `${GITHUB}/blob/main/docs/INSTALL.md`

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

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 96 96" aria-hidden="true">
      <rect width="24" height="96" rx="10" fill="#c9e878" />
      <rect x="32" width="64" height="56" rx="10" fill="#c9e878" />
      <rect x="32" y="64" width="64" height="32" rx="10" fill="#557f2f" />
    </svg>
  )
}

const principles = [
  {
    title: "Keys you already know",
    copy: "Tab between the panels, F5 to copy, F6 to move, Insert to mark. The keyboard model follows Total Commander, and every shortcut can be remapped.",
  },
  {
    title: "An interface for today",
    copy: "One design system across both apps, in light and dark, at the interface size you choose, in eight languages.",
  },
  {
    title: "Nothing waits",
    copy: "Scrolling and the cursor never wait for thumbnails, listings or a running copy. Long work goes to a background queue you can watch, pause and cancel.",
  },
]

const viewerFeatures = [
  {
    title: "Tiles for very large folders",
    copy: "Small, medium or large tiles that reflow with the window. Only what is on screen is drawn, so a folder of 100,000 pictures scrolls like a folder of a hundred.",
  },
  {
    title: "A closer look",
    copy: "Zoom and pan a still, play local video, and step through the folder with the arrow keys or the wheel. Thumbnails are cached, so a second visit is immediate.",
  },
  {
    title: "Search, sort and filter",
    copy: "Find a file by name, sort by name, date, size or type, and keep bookmarks and recent folders in the sidebar next to the folder tree.",
  },
  {
    title: "An editor built in",
    copy: "Crop and straighten, adjust light and color with levels and curves, add borders and watermarks, retouch. Save the steps as a recipe and run it over a whole folder.",
  },
]

const commanderFeatures = [
  {
    title: "Three views per panel",
    copy: "Full with sortable, resizable columns, Brief with names in columns, and Thumbnails. Tabs in each panel, and tab sets you can save.",
  },
  {
    title: "A queue for the heavy work",
    copy: "Copy, move and delete run in the background with progress, pause and a clear dialog for conflicts. Both panels stay usable throughout.",
  },
  {
    title: "Find, compare, synchronize",
    copy: "Find files by name, content, size or date. Compare two folders and synchronize them, compare files line by line, create and verify checksums.",
  },
  {
    title: "Archives and servers as folders",
    copy: "Enter a zip or tar archive as you would a folder, pack and unpack, and connect to FTP and FTPS servers with saved connections.",
  },
  {
    title: "Rename many at once",
    copy: "A multi-rename tool with counters, search and replace and a preview of every new name, plus undo for the last run.",
  },
  {
    title: "Quick view and lister",
    copy: "See the file under the cursor in the other panel, or open text, hex, pictures and video in the lister with F3.",
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

const shots = [
  {
    src: shotTiles,
    label: "VIEWER / TILES",
    title: "A folder at a glance, with the preview beside it.",
    alt: "The Panelyth viewer showing a folder of landscape photographs as tiles, with the folder tree and a preview of the selected picture on the left",
    wide: true,
  },
  {
    src: shotPhoto,
    label: "VIEWER / PICTURE",
    title: "One picture, the whole window.",
    alt: "A single photograph opened in Panelyth's media window",
  },
  {
    src: shotEditor,
    label: "VIEWER / EDITOR",
    title: "Adjust, retouch and save a copy.",
    alt: "Panelyth's image editor with its tools beside a photograph",
  },
  {
    src: shotCommander,
    label: "COMMANDER / PANELS",
    title: "Two folders, side by side.",
    alt: "Panelyth Commander with a file list on the left, thumbnails on the right and the function-key bar",
    wide: true,
  },
  {
    src: shotFiles,
    label: "COMMANDER / TWO PANELS",
    title: "Files on the left, files on the right, marks in between.",
    alt: "Panelyth Commander with two folders of files in the Full view, five files marked in the left panel",
    span: true,
  },
  {
    src: shotQuickView,
    label: "COMMANDER / QUICK VIEW",
    title: "The file under the cursor, in the other panel.",
    alt: "Panelyth Commander showing a quick view of a picture in the right panel",
  },
  {
    src: shotFind,
    label: "COMMANDER / FIND FILES",
    title: "Search by size, date and attributes.",
    alt: "The Find files dialog of Panelyth Commander on its Advanced tab, with a minimum size and a date range filled in",
  },
  {
    src: shotFindResults,
    label: "COMMANDER / SEARCH RESULTS",
    title: "Go to a result, or feed them all to a panel.",
    alt: "The Find files dialog listing 32 results with their folders and sizes",
  },
  {
    src: shotLight,
    label: "VIEWER / LIGHT THEME",
    title: "Large tiles, in the light theme.",
    alt: "The Panelyth viewer in the light theme, showing a folder of photographs as large tiles",
  },
]

/** The hero's slides: the viewer and the commander in turn. */
const heroSlides = [
  shotTiles,
  shotCommander,
  shotPhoto,
  shotFiles,
  shotEditor,
  shotFindResults,
].map((src) => shots.find((shot) => shot.src === src))
/** How long the hero shows one slide. */
const SLIDE_MS = 5000

/** The two wide shots head the app sections; the gallery shows the rest. */
const gallery = shots.filter((shot) => !shot.wide)

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
      <AppWindow title={`Panelyth — ${slide.label.startsWith("VIEWER") ? "Viewer" : "Commander"}`}>
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

function FeatureList({ items }) {
  return (
    <ul className="feature-list">
      {items.map((item, index) => (
        <li key={item.title}>
          <span className="feature-number">{String(index + 1).padStart(2, "0")}</span>
          <div>
            <h3>{item.title}</h3>
            <p>{item.copy}</p>
          </div>
        </li>
      ))}
    </ul>
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
        <span>07 / DOWNLOAD</span>
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
                A photo and video browser and a keyboard-first, two-panel file manager, sharing one
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
              <b>LOCAL FIRST · NO ACCOUNT</b>
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

        <section className="app-section" id="viewer">
          <div className="section-topline">
            <span>03 / VIEWER</span>
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
          <div className="app-layout">
            <AppWindow title="Panelyth — Viewer">
              <Screenshot shot={shots[0]} />
            </AppWindow>
            <FeatureList items={viewerFeatures} />
          </div>
        </section>

        <section className="app-section app-section-alt" id="commander">
          <div className="section-topline">
            <span>04 / COMMANDER</span>
            <span>
              TWO PANELS · KEYBOARD FIRST <i>✳</i>
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
          <div className="app-layout app-layout-reverse">
            <AppWindow title="Panelyth — Commander">
              <Screenshot shot={shots[3]} />
            </AppWindow>
            <FeatureList items={commanderFeatures} />
          </div>
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
            <span>05 / ONE WINDOW</span>
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
            <span>06 / IN THE APP</span>
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
            <span>08 / ABOUT</span>
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
                across updates.
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
        <span className="footer-copy">© 2026 PANELYTH</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById("root")).render(<App />)
