import { Fragment, type ReactNode } from "react"
import { useLocaleStore } from "./store"

/**
 * Remounts its children when the language changes, so every t() call in the
 * tree runs again (ADR-0034). Stores live outside React, so the app's state
 * survives; only components' local state resets.
 */
export function LocaleBoundary({ children }: { children: ReactNode }) {
  const locale = useLocaleStore((s) => s.locale)
  return <Fragment key={locale}>{children}</Fragment>
}
