import { useEffect } from "react"
import { markOnce } from "../perf/marks"
import { AppShell } from "./AppShell"
import { ErrorBoundary } from "./ErrorBoundary"

export function App() {
  useEffect(() => markOnce("fv:first-render"), [])
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  )
}
