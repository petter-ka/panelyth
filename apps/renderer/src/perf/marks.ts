// Renderer performance marks. Names are read by the e2e/benchmark harness.
export type RendererMark = "fv:first-render" | "fv:sidecar-ready-seen"

export function markOnce(name: RendererMark): void {
  if (performance.getEntriesByName(name, "mark").length === 0) performance.mark(name)
}
