/** Imperative pane actions, registered by the app shell that owns the panels. */
export interface PaneControls {
  toggle(id: "sidebar" | "preview"): void
  /** Shows a collapsed pane (no-op when it is open). */
  expand(id: "sidebar" | "preview"): void
}

let controls: PaneControls | null = null

export function registerPaneControls(c: PaneControls): () => void {
  controls = c
  return () => {
    if (controls === c) controls = null
  }
}

export function togglePane(id: "sidebar" | "preview"): void {
  controls?.toggle(id)
}

export function expandPane(id: "sidebar" | "preview"): void {
  controls?.expand(id)
}
