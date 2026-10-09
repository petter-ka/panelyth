import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"

const Arrow = ({ diagonal = false }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 20 20"
    className={diagonal ? "arrow arrow-diagonal" : "arrow"}
  >
    <path d="M3.5 10h12M10 4.5l5.5 5.5-5.5 5.5" />
  </svg>
)

const BrandMark = () => (
  <span className="brand-mark" aria-hidden="true">
    <span />
    <span />
    <span />
    <span />
  </span>
)

const rowsLeft = [
  { icon: "folder", name: "Alpine trip", ext: "DIR", size: "—", active: true },
  { icon: "image", name: "IMG_2048", ext: "JPG", size: "4.8 MB" },
  { icon: "image", name: "IMG_2049", ext: "JPG", size: "5.1 MB" },
  { icon: "video", name: "summit-cut", ext: "MP4", size: "1.2 GB" },
  { icon: "text", name: "field-notes", ext: "MD", size: "18 KB" },
]

const rowsRight = [
  { icon: "folder", name: "Alpine trip", ext: "DIR", size: "—", active: true },
  { icon: "image", name: "IMG_2048", ext: "JPG", size: "4.8 MB", match: true },
  { icon: "image", name: "IMG_2049", ext: "JPG", size: "4.9 MB", changed: true },
  { icon: "folder", name: "selects", ext: "DIR", size: "—" },
  { icon: "text", name: "field-notes", ext: "MD", size: "18 KB", match: true },
]

function FileRow({ file }) {
  return (
    <div
      className={`file-row${file.active ? " is-active" : ""}${file.match ? " is-match" : ""}${file.changed ? " is-changed" : ""}`}
    >
      <span className={`file-icon file-icon-${file.icon}`} aria-hidden="true">
        {file.icon === "folder"
          ? "▰"
          : file.icon === "image"
            ? "◩"
            : file.icon === "video"
              ? "▶"
              : "≡"}
      </span>
      <span className="file-name">{file.name}</span>
      <span className="file-ext">{file.ext}</span>
      <span className="file-size">{file.size}</span>
      <span className="file-state" aria-hidden="true">
        {file.match ? "●" : file.changed ? "↗" : ""}
      </span>
    </div>
  )
}

function CommanderWindow() {
  return (
    <div
      className="hero-window"
      role="img"
      aria-label="Illustrated preview of planned Panelyth Commander, showing two file panels and a copy job"
    >
      <div className="window-topbar">
        <div className="window-brand">
          <BrandMark />
          <span>
            panelyth <b>commander</b>
          </span>
        </div>
        <div className="window-session">
          <span className="live-dot" /> APP VIEW <span className="session-separator">/</span> PANELS
          READY
        </div>
        <div className="window-controls" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="window-toolbar">
        <div className="toolbar-actions">
          <span>↶</span>
          <span>↷</span>
          <span className="toolbar-divider" />
          <span>＋</span>
          <span>⌕</span>
        </div>
        <div className="toolbar-label">
          COMMANDER <span>·</span> LOCAL FILESYSTEM
        </div>
        <div className="toolbar-kbd">
          <kbd>CTRL</kbd>
          <kbd>SHIFT</kbd>
          <kbd>M</kbd>
        </div>
      </div>
      <div className="commander-panels">
        <div className="commander-panel">
          <div className="panel-drive-row">
            <span className="drive-pill">C:</span>
            <span className="drive-name">WORKSTATION</span>
            <span className="drive-free">412 GB FREE</span>
          </div>
          <div className="panel-tabs">
            <span className="panel-tab is-current">Alpine trip</span>
            <span className="panel-tab">Photos</span>
            <span className="panel-tab-add">+</span>
          </div>
          <div className="panel-path">
            <span>⌂</span>
            <span>Pictures</span>
            <b>/</b>
            <strong>Alpine trip</strong>
          </div>
          <div className="file-list-heading">
            <span>
              NAME <b>↓</b>
            </span>
            <span>EXT</span>
            <span>SIZE</span>
            <span />
          </div>
          <div className="file-list">
            {rowsLeft.map((file) => (
              <FileRow key={file.name} file={file} />
            ))}
          </div>
          <div className="panel-status">
            <span>5 ITEMS</span>
            <span>1 MARKED · 1.2 GB</span>
          </div>
        </div>
        <div className="panel-split" aria-hidden="true">
          <span>⇄</span>
        </div>
        <div className="commander-panel">
          <div className="panel-drive-row">
            <span className="drive-pill drive-pill-muted">D:</span>
            <span className="drive-name">FIELD ARCHIVE</span>
            <span className="drive-free">1.2 TB FREE</span>
          </div>
          <div className="panel-tabs">
            <span className="panel-tab is-current">Alpine trip</span>
            <span className="panel-tab">Backup</span>
            <span className="panel-tab-add">+</span>
          </div>
          <div className="panel-path">
            <span>⌂</span>
            <span>Archive</span>
            <b>/</b>
            <strong>Alpine trip</strong>
          </div>
          <div className="file-list-heading">
            <span>
              NAME <b>↓</b>
            </span>
            <span>EXT</span>
            <span>SIZE</span>
            <span />
          </div>
          <div className="file-list">
            {rowsRight.map((file) => (
              <FileRow key={file.name} file={file} />
            ))}
          </div>
          <div className="panel-status">
            <span>5 ITEMS</span>
            <span>
              <i className="sync-indicator" /> COMPARE READY
            </span>
          </div>
        </div>
      </div>
      <div className="window-functionbar">
        <div>
          <kbd>F3</kbd>
          <span>View</span>
        </div>
        <div>
          <kbd>F4</kbd>
          <span>Edit</span>
        </div>
        <div className="function-primary">
          <kbd>F5</kbd>
          <span>Copy</span>
        </div>
        <div>
          <kbd>F6</kbd>
          <span>Move</span>
        </div>
        <div>
          <kbd>F7</kbd>
          <span>New folder</span>
        </div>
        <div>
          <kbd>F8</kbd>
          <span>Delete</span>
        </div>
        <div className="function-queue">
          <span className="queue-pulse" /> <span>Copying 124 files</span>
          <span className="queue-progress">
            <i />
          </span>
          <b>62%</b>
        </div>
      </div>
      <div className="window-bottomline">
        <span>
          F5 COPY <span className="muted-dot">·</span> F6 MOVE <span className="muted-dot">·</span>{" "}
          TAB SWITCH PANEL
        </span>
        <span>
          BUILT FOR FLOW <span className="bottom-star">✳</span>
        </span>
      </div>
    </div>
  )
}

function ImagePlaceholder({ variant, label }) {
  return (
    <div
      className={`image-placeholder image-placeholder-${variant}`}
      role="img"
      aria-label={`${label} image placeholder`}
    >
      <div className="placeholder-grid" />
      {variant === "viewer" && (
        <div className="placeholder-viewer">
          <span className="media-tile media-tile-wide" />
          <span className="media-tile media-tile-tall" />
          <span className="media-tile" />
          <span className="media-tile" />
          <span className="media-tile media-tile-wide" />
        </div>
      )}
      {variant === "panels" && (
        <div className="placeholder-panels">
          <span>
            <i />
            <i />
            <i />
            <i />
          </span>
          <b>⇄</b>
          <span>
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
      )}
      {variant === "sync" && (
        <div className="placeholder-sync">
          <span className="sync-disc sync-disc-a" />
          <span className="sync-disc sync-disc-b" />
          <i>≠</i>
        </div>
      )}
      {variant === "rename" && (
        <div className="placeholder-rename">
          <div>
            <b>IMG_2048.jpg</b>
            <span>→</span>
            <strong>alpine_001.jpg</strong>
          </div>
          <div>
            <b>IMG_2049.jpg</b>
            <span>→</span>
            <strong>alpine_002.jpg</strong>
          </div>
          <div>
            <b>IMG_2050.jpg</b>
            <span>→</span>
            <strong>alpine_003.jpg</strong>
          </div>
        </div>
      )}
      <div className="placeholder-caption">
        <span>VISUAL PLACEHOLDER</span>
        <span>{label}</span>
      </div>
      <span className="placeholder-corner" aria-hidden="true">
        ↗
      </span>
    </div>
  )
}

function FeatureCard({ index, category, title, description, shortcut, visual }) {
  return (
    <article className={`feature-card feature-card-${visual} reveal`}>
      <ImagePlaceholder variant={visual} label={`0${index} / ${category.toUpperCase()}`} />
      <div className="feature-card-copy">
        <div className="feature-kicker">
          <span>0{index}</span>
          <span>{category}</span>
        </div>
        <h3>{title}</h3>
        <p>{description}</p>
        <div className="feature-foot">
          <span>{shortcut}</span>
          <a href="#details" aria-label={`Explore ${category}`}>
            <Arrow diagonal />
          </a>
        </div>
      </div>
    </article>
  )
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const revealElements = document.querySelectorAll(".reveal")

    if ("IntersectionObserver" in window && !reduceMotion) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible")
              observer.unobserve(entry.target)
            }
          })
        },
        { threshold: 0.14 },
      )
      revealElements.forEach((element) => observer.observe(element))
      return () => observer.disconnect()
    }

    revealElements.forEach((element) => element.classList.add("is-visible"))
    return undefined
  }, [])

  useEffect(() => {
    const hero = document.querySelector(".hero")
    const preview = document.querySelector(".hero-window")
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!hero || !preview || reduceMotion || window.innerWidth < 760) return undefined

    let frame = 0
    const onPointerMove = (event) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bounds = hero.getBoundingClientRect()
        const x = (event.clientX - bounds.left) / bounds.width - 0.5
        const y = (event.clientY - bounds.top) / bounds.height - 0.5
        preview.style.setProperty("--tilt-y", `${x * 1.2}deg`)
        preview.style.setProperty("--tilt-x", `${-y * 1.2}deg`)
      })
    }
    const onPointerLeave = () => {
      preview.style.setProperty("--tilt-y", "0deg")
      preview.style.setProperty("--tilt-x", "0deg")
    }
    hero.addEventListener("pointermove", onPointerMove, { passive: true })
    hero.addEventListener("pointerleave", onPointerLeave, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      hero.removeEventListener("pointermove", onPointerMove)
      hero.removeEventListener("pointerleave", onPointerLeave)
    }
  }, [])

  const closeMenu = () => setMenuOpen(false)

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
          <a href="#features" onClick={closeMenu}>
            Features
          </a>
          <a href="#workflow" onClick={closeMenu}>
            Product family
          </a>
          <a href="#details" onClick={closeMenu}>
            Architecture
          </a>
        </nav>
        <a className="header-cta" href="#project">
          Project details <Arrow diagonal />
        </a>
      </header>

      <main>
        <section className="hero" id="top">
          <div className="hero-grain" aria-hidden="true" />
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="eyebrow-dot" /> PANELYTH / LOCAL DESKTOP TOOLS{" "}
              <span className="eyebrow-rule" />
            </div>
            <h1>
              Two tools.
              <br />
              <em>One workspace.</em>
            </h1>
            <div className="hero-support">
              <p>
                Browse large photo libraries and local video in Panelyth. A planned Commander view
                adds keyboard-first file work in the same workspace.
              </p>
              <a className="round-link" href="#features" aria-label="Scroll to features">
                <Arrow />
              </a>
            </div>
            <div className="hero-index">
              <span>PANELYTH PRODUCT FAMILY</span>
              <span>
                WINDOWS <b>·</b> macOS <b>·</b> LINUX
              </span>
            </div>
          </div>
          <div className="hero-art">
            <div className="hero-art-note">
              <span>APP / 02 · PLANNED</span>
              <b>DUAL PANEL VIEW</b>
              <span className="art-note-line" />
            </div>
            <span className="orbit orbit-one" aria-hidden="true" />
            <span className="orbit orbit-two" aria-hidden="true" />
            <CommanderWindow />
            <div className="floating-chip chip-sync">
              <span className="chip-glyph">⇄</span>
              <span>
                <b>Compare & sync</b>
                <small>Side by side. Always.</small>
              </span>
              <i />
            </div>
            <div className="floating-chip chip-shortcut">
              <span className="shortcut-key">TAB</span>
              <span>
                <b>Switch panels</b>
                <small>Keep your hands moving.</small>
              </span>
            </div>
          </div>
          <div className="hero-scroll">
            <span className="scroll-line" /> SCROLL TO EXPLORE
          </div>
        </section>

        <section className="intro-band" id="workflow">
          <div className="section-meta">
            <span>01 / PRODUCT FAMILY</span>
            <span>
              ONE WINDOW · SHARED CONTEXT <i>✳</i>
            </span>
          </div>
          <div className="intro-content reveal">
            <h2>
              Made for your
              <br />
              <em>whole library.</em>
            </h2>
            <div className="intro-aside">
              <p>
                One app window, two purpose-built tools. Your folder, current file and selection
                follow when you switch between them.
              </p>
              <span className="intro-aside-index">
                01<span>/</span>02
              </span>
            </div>
          </div>
          <div className="workflow-strip" aria-label="Panelyth viewer and Commander share context">
            <div>
              <span>APP / 01</span>
              <b>Panelyth</b>
              <small>Photos · Video</small>
            </div>
            <i>⇄</i>
            <div>
              <span>SHARED CONTEXT</span>
              <b>Folder · File · Selection</b>
              <small>Bookmarks · Recents · Clipboard</small>
            </div>
            <i>⇄</i>
            <div>
              <span>APP / 02 · PLANNED</span>
              <b>Commander</b>
              <small>Dual-panel file manager</small>
            </div>
          </div>
        </section>

        <section className="features-section" id="features">
          <div className="section-meta">
            <span>02 / CORE CAPABILITIES</span>
            <span>
              KEYBOARD FIRST <i>✳</i>
            </span>
          </div>
          <div className="features-heading reveal">
            <div>
              <span className="eyebrow eyebrow-dark">
                <span className="eyebrow-dot" /> TWO APP EXPERIENCES
              </span>
              <h2>
                Fluid browsing.
                <br />
                Direct <em>control.</em>
              </h2>
            </div>
            <p>
              Move from a fast visual library to precise file operations, with shared context and a
              purpose-built interface for each job.
            </p>
          </div>
          <div className="feature-grid">
            <FeatureCard
              index={1}
              category="Panelyth viewer"
              title="A fluid media library."
              description="Browse huge photo folders, keep previews ready in a persistent cache, and play video locally."
              shortcut="TILES · PREVIEW · VIDEO"
              visual="viewer"
            />
            <FeatureCard
              index={2}
              category="Commander · planned"
              title="Two panels. One glance."
              description="Work between locations with tabs, marks and a keyboard-first layout. Keep both sides visible."
              shortcut="TAB · F5 COPY"
              visual="panels"
            />
            <FeatureCard
              index={3}
              category="Compare & sync"
              title="See what changed."
              description="Compare folders and files, then choose which way each difference should move."
              shortcut="SHIFT + F2 · SYNC"
              visual="sync"
            />
            <FeatureCard
              index={4}
              category="Batch operations"
              title="Handle the whole set."
              description="Find, archive, queue and rename files with previews, progress and clear conflict choices."
              shortcut="FIND · ARCHIVE · RENAME"
              visual="rename"
            />
          </div>
        </section>

        <section className="detail-section" id="details">
          <div
            className="detail-art reveal"
            role="img"
            aria-label="System architecture diagram: React interface, Electron desktop shell, and Go sidecar"
          >
            <div className="detail-placeholder-label">
              <span>PANELYTH / SYSTEM MAP</span>
              <span>LOCAL DESKTOP APP</span>
            </div>
            <div className="architecture-flow">
              <div className="architecture-node node-renderer">
                <span>01 / INTERFACE</span>
                <b>React</b>
                <small>Panels · Search · Queue</small>
              </div>
              <div className="architecture-link">
                <span>APP VIEW</span>
                <i />
              </div>
              <div className="architecture-node node-shell">
                <span>02 / DESKTOP</span>
                <b>Electron</b>
                <small>Window · Native access</small>
              </div>
              <div className="architecture-link">
                <span>FRAMED RPC</span>
                <i />
              </div>
              <div className="architecture-node node-core">
                <span>03 / FILE SERVICES</span>
                <b>Go sidecar</b>
                <small>Index · Preview · Jobs</small>
              </div>
            </div>
            <div className="detail-art-caption">
              <span>ONE SHARED PLATFORM</span>
              <span>RENDERER → SHELL → CORE</span>
            </div>
          </div>
          <div className="detail-copy reveal">
            <div className="section-meta">
              <span>03 / PROJECT ARCHITECTURE</span>
            </div>
            <span className="eyebrow eyebrow-dark">
              <span className="eyebrow-dot" /> CLEAR RESPONSIBILITIES
            </span>
            <h2>
              Small UI.
              <br />
              Serious
              <br />
              <em>engine.</em>
            </h2>
            <p>
              React owns the interface. Electron provides the desktop shell. A Go sidecar handles
              indexing, previews and background file jobs.
            </p>
            <ul className="detail-list">
              <li>
                <span>01</span> Browse ZIP and TAR archives <i>↗</i>
              </li>
              <li>
                <span>02</span> Find files across folders <i>↗</i>
              </li>
              <li>
                <span>03</span> Queue work and come back later <i>↗</i>
              </li>
            </ul>
            <a className="text-link" href="#project">
              Project structure <Arrow />
            </a>
          </div>
        </section>

        <section className="project-section" id="project">
          <div className="section-meta">
            <span>04 / PROJECT NOTES</span>
            <span>
              PANELYTH <i>✳</i>
            </span>
          </div>
          <div className="project-heading reveal">
            <div>
              <span className="eyebrow eyebrow-dark">
                <span className="eyebrow-dot" /> THE STACK
              </span>
              <h2>
                Designed in layers.
                <br />
                <em>Documented in code.</em>
              </h2>
            </div>
            <p>
              Local-first apps for Windows, macOS and Linux, built on a shared desktop platform.
            </p>
          </div>
          <div className="project-grid reveal">
            <article className="project-module">
              <div className="module-top">
                <span>UI / 01</span>
                <span className="module-state">
                  <i /> INTERFACE
                </span>
              </div>
              <b>React renderer</b>
              <p>Panels, keyboard flow, dialogs and live job feedback.</p>
              <span className="module-tag">TYPESCRIPT · REACT</span>
            </article>
            <article className="project-module">
              <div className="module-top">
                <span>SHELL / 02</span>
                <span className="module-state">
                  <i /> DESKTOP
                </span>
              </div>
              <b>Electron</b>
              <p>App lifecycle, native integration and a restricted bridge.</p>
              <span className="module-tag">MAIN · PRELOAD</span>
            </article>
            <article className="project-module">
              <div className="module-top">
                <span>SERVICES / 03</span>
                <span className="module-state">
                  <i /> FILE CORE
                </span>
              </div>
              <b>Go</b>
              <p>Indexing, previews, file operations and cancellable jobs.</p>
              <span className="module-tag">INDEX · JOBS · MEDIA</span>
            </article>
          </div>
          <div className="project-footer">
            <span>
              <i /> SOURCE TREE / VIEWER · COMMANDER · SHARED · DOCS
            </span>
            <span>UI ↔ SHELL ↔ FILE SERVICES</span>
            <a href="#top">BACK TO TOP ↑</a>
          </div>
        </section>

        <section className="closing-section">
          <div className="closing-orbit" aria-hidden="true" />
          <div className="closing-meta">
            <span>05 / PANELYTH</span>
            <span>
              LOCAL-FIRST DESKTOP APPS <i>✳</i>
            </span>
          </div>
          <h2>
            Your library.
            <br />
            <em>In good hands.</em>
          </h2>
          <a href="#features" className="closing-link">
            Explore the apps{" "}
            <span>
              <Arrow diagonal />
            </span>
          </a>
          <div className="closing-bottom">
            <span>ONE WINDOW · TWO APP EXPERIENCES</span>
            <span>BUILT FOR LARGE LIBRARIES.</span>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <a className="brand footer-brand" href="#top">
          <BrandMark />
          <span>panelyth</span>
        </a>
        <span className="footer-note">REACT · ELECTRON · GO</span>
        <div className="footer-links">
          <a href="#features">Features</a>
          <a href="#top">Back to top ↑</a>
        </div>
        <span className="footer-copy">© 2026 PANELYTH</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById("root")).render(<App />)
