import { useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"

const Arrow = ({ diagonal = false }) => (
  <svg aria-hidden="true" viewBox="0 0 20 20" className={diagonal ? "arrow arrow-diagonal" : "arrow"}>
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

const highlights = [
  {
    title: "A library that stays local",
    copy: "Browse folders on your computer. Your photos and videos stay on your device.",
  },
  {
    title: "Built for big folders",
    copy: "Move through large collections with a responsive grid and previews ready when you are.",
  },
  {
    title: "Photos and video together",
    copy: "Scan stills, play clips, and keep the whole shoot in one familiar place.",
  },
  {
    title: "A closer look, quickly",
    copy: "Open a focused preview, check file details, and move to the next item without losing your place.",
  },
  {
    title: "Folders and archives",
    copy: "Navigate everyday folders and browse supported ZIP and TAR archives in the same workspace.",
  },
  {
    title: "Work that keeps moving",
    copy: "Search, copy, rename, and queue file tasks with progress you can follow.",
  },
]

const media = [
  { name: "Tre Cime", kind: "alpine", selected: true },
  { name: "Morning light", kind: "lake" },
  { name: "Ridge trail", kind: "ridge" },
  { name: "Pine forest", kind: "forest" },
  { name: "Last light", kind: "sunset" },
]

function ProductWindow() {
  return (
    <div className="product-window" role="img" aria-label="Illustration of Panelyth browsing a photo folder">
      <div className="window-chrome">
        <div className="chrome-controls" aria-hidden="true"><i /><i /><i /></div>
        <div className="chrome-brand"><BrandMark /><span>panelyth</span></div>
        <div className="chrome-location"><span>Pictures</span><b>/</b><strong>Dolomites</strong></div>
        <span className="chrome-status"><i /> LOCAL LIBRARY</span>
      </div>
      <div className="window-body">
        <aside className="app-sidebar" aria-hidden="true">
          <div className="sidebar-label">LIBRARY</div>
          <div className="sidebar-item is-active"><span>▦</span> All media <small>248</small></div>
          <div className="sidebar-item"><span>▧</span> Photos <small>212</small></div>
          <div className="sidebar-item"><span>▷</span> Video <small>36</small></div>
          <div className="sidebar-label sidebar-label-spaced">PLACES</div>
          <div className="sidebar-place"><i /> Pictures</div>
          <div className="sidebar-place is-nested"><i /> Dolomites</div>
          <div className="sidebar-place"><i /> Recent folders</div>
          <div className="sidebar-bottom"><span className="drive-icon">C:</span><span>Local disk<small>412 GB free</small></span></div>
        </aside>
        <div className="app-main">
          <div className="app-toolbar">
            <div><strong>Dolomites</strong><span>248 items</span></div>
            <div className="toolbar-tools"><span>⌕</span><span>⇅</span><span className="view-toggle">▦ &nbsp; ▤</span></div>
          </div>
          <div className="media-grid">
            {media.map((item, index) => (
              <div key={item.name} className={`media-tile${index === 0 ? " media-tile-large" : ""}${item.selected ? " is-selected" : ""}`}>
                <div className={`landscape landscape-${item.kind}`} aria-hidden="true"><i /><b /><span /></div>
                <span className="tile-title">{item.name}</span>
                <span className="tile-meta">{index === 0 ? "JPG · 8.4 MB" : index === 2 ? "MP4 · 00:18" : "JPG · 5.1 MB"}</span>
                {item.kind === "ridge" && <span className="video-mark" aria-hidden="true">▶</span>}
              </div>
            ))}
          </div>
          <div className="app-status"><span>248 ITEMS</span><span>1 SELECTED</span><span>100%</span></div>
        </div>
        <aside className="app-inspector" aria-hidden="true">
          <div className="inspector-title">INFORMATION <span>···</span></div>
          <div className="inspector-preview"><div className="landscape landscape-alpine"><i /><b /><span /></div></div>
          <strong>Tre Cime</strong>
          <small>IMG_1842.JPG</small>
          <div className="inspector-rule" />
          <div className="inspector-row"><span>Dimensions</span><b>4032 × 3024</b></div>
          <div className="inspector-row"><span>File size</span><b>8.4 MB</b></div>
          <div className="inspector-row"><span>Created</span><b>18 Jun 2025</b></div>
          <div className="inspector-tag"><i /> ON THIS DEVICE</div>
        </aside>
      </div>
      <div className="window-foot"><span><kbd>←</kbd><kbd>→</kbd> Navigate</span><span><kbd>SPACE</kbd> Preview</span><span>PICTURES / DOLOMITES</span></div>
    </div>
  )
}

function MiniWindow({ variant }) {
  return (
    <div className={`mini-window mini-window-${variant}`} aria-hidden="true">
      <div className="mini-top"><span /><span /><span /><b>panelyth</b><i>···</i></div>
      <div className="mini-content">
        <div className="mini-rail"><i /><i /><i /><i /></div>
        {variant === "grid" && <div className="mini-grid">{["alpine", "lake", "ridge", "forest", "sunset", "lake"].map((kind, i) => <i key={i} className={`landscape landscape-${kind}`} />)}</div>}
        {variant === "preview" && <div className="mini-preview"><i className="landscape landscape-alpine" /><div><b>Tre Cime</b><span>4032 × 3024 · JPG</span><span>8.4 MB</span></div></div>}
        {variant === "jobs" && <div className="mini-jobs"><b>Background jobs</b><div><i /><span>Copy selected files<small>68 of 124 files</small></span><em>54%</em></div><div><i /><span>Build previews<small>Preparing thumbnails</small></span><em>RUNNING</em></div><div><i /><span>Archive folder<small>Waiting in queue</small></span><em>QUEUED</em></div></div>}
      </div>
    </div>
  )
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Panelyth home" onClick={closeMenu}><BrandMark /><span>panelyth</span></a>
        <button className="menu-toggle" type="button" aria-expanded={menuOpen} aria-controls="site-nav" onClick={() => setMenuOpen(!menuOpen)}>
          <span>{menuOpen ? "Close" : "Menu"}</span><i className={menuOpen ? "menu-icon is-open" : "menu-icon"}><b /><b /></i>
        </button>
        <nav className={menuOpen ? "site-nav is-open" : "site-nav"} id="site-nav" aria-label="Main navigation">
          <a href="#highlights" onClick={closeMenu}>Highlights</a>
          <a href="#screenshots" onClick={closeMenu}>Screenshots</a>
          <a href="#about" onClick={closeMenu}>About Panelyth</a>
        </nav>
        <a className="header-cta" href="#highlights" onClick={closeMenu}>Explore Panelyth <Arrow diagonal /></a>
      </header>

      <main>
        <section className="hero" id="top">
          <div className="hero-heading">
            <div className="section-label"><span>01</span><i /> PANELYTH</div>
            <h1>Your media,<br /><em>in clear view.</em></h1>
            <div className="hero-intro">
              <p>A thoughtful desktop browser for photo and video libraries. Fast to navigate, easy to focus, and always on your device.</p>
              <a className="hero-link" href="#highlights">Explore the highlights <span><Arrow /></span></a>
            </div>
            <div className="platform-line"><span>WINDOWS</span><i /> <span>macOS</span><i /> <span>LINUX</span><b>LOCAL FIRST · DESKTOP APP</b></div>
          </div>
          <div className="hero-visual">
            <ProductWindow />
            <div className="visual-caption"><span>Panelyth · Media browser</span><span>Illustrative interface</span></div>
          </div>
        </section>

        <section className="highlights-section" id="highlights">
          <div className="section-topline"><span>02 / HIGHLIGHTS</span><span>MADE FOR YOUR FILES <i>✳</i></span></div>
          <div className="highlights-heading"><h2>What's<br />inside.</h2><p>Everything you need to move through a media folder, without getting between you and the work.</p></div>
          <div className="highlight-grid">
            {highlights.map((item, index) => (
              <article className="highlight" key={item.title}>
                <div className="highlight-number">0{index + 1}<span> / 06</span></div>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="screenshots-section" id="screenshots">
          <div className="section-topline"><span>03 / IN THE APP</span><span>ONE PLACE FOR THE WHOLE FOLDER <i>✳</i></span></div>
          <div className="screenshots-heading"><h2>Made to keep<br /><em>you moving.</em></h2><p>From the first scan to the last file in the queue, the details stay close at hand.</p></div>
          <div className="shot-grid">
            <figure className="shot-card shot-card-wide"><MiniWindow variant="grid" /><figcaption><span>01 / MEDIA GRID</span><b>See the folder at a glance.</b></figcaption></figure>
            <figure className="shot-card"><MiniWindow variant="preview" /><figcaption><span>02 / QUICK PREVIEW</span><b>Stay with the moment.</b></figcaption></figure>
            <figure className="shot-card"><MiniWindow variant="jobs" /><figcaption><span>03 / BACKGROUND WORK</span><b>Know what's happening.</b></figcaption></figure>
          </div>
        </section>

        <section className="about-section" id="about">
          <div className="section-topline"><span>04 / ABOUT PANELYTH</span><span>LOCAL FILES · CLEAR WORKFLOW</span></div>
          <div className="about-content">
            <div className="about-copy"><h2>Your library.<br /><em>Your machine.</em></h2><p>Panelyth is a local-first desktop app for browsing photo and video folders. It is built around a simple idea: your files should stay yours, and finding the right one should feel effortless.</p><a href="#top" className="about-link">Back to the top <Arrow /></a></div>
            <div className="stack-card"><div className="stack-card-head"><span>PROJECT / STACK</span><span>01 — 03</span></div><div className="stack-row"><span>01</span><b>React</b><small>Interface</small></div><div className="stack-row"><span>02</span><b>Electron</b><small>Desktop app</small></div><div className="stack-row"><span>03</span><b>Go</b><small>File services</small></div><div className="stack-card-foot"><i /> LOCAL FIRST EXPERIENCE <span>BUILT FOR DESKTOP</span></div></div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <a className="brand footer-brand" href="#top"><BrandMark /><span>panelyth</span></a>
        <span className="footer-note">A CLEARER WAY THROUGH YOUR MEDIA.</span>
        <a className="footer-top" href="#top">BACK TO TOP <span>↑</span></a>
        <span className="footer-copy">© 2026 PANELYTH</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById("root")).render(<App />)
