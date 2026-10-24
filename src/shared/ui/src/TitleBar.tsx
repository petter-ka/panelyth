import { useEffect, type ReactNode } from "react"
import markUrl from "./assets/mark.svg"
import { t } from "@panelyth/i18n"
import { TitleBarDivider } from "./TitleBarControls"
import {
  useTitleBarShown,
  useWindowFrameStore,
  windowControl,
  type WindowControlAction,
} from "./windowFrame"

export interface TitleBarProps {
  /** The product name (not translated, ADR-0034). */
  title: string
  /** Where the app is: the folder shown, or the active panel's. */
  detail?: string | null
  /** The app's view switchers, beside the window buttons (TitleBarControls.tsx). */
  controls?: ReactNode
  /** The app has the rail: the mark takes the corner above it (false: the viewer alone). */
  rail?: boolean
  /**
   * A window of its own (the settings, document and editor windows): no rail,
   * so the mark starts the strip itself.
   */
  mark?: boolean
}

const button =
  "grid size-[26px] place-items-center rounded-md text-muted transition-colors duration-(--motion-fast) focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
const plainHover = "hover:bg-raised hover:text-text"

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function ControlButton({
  action,
  label,
  className = plainHover,
  children,
}: {
  action: WindowControlAction
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={`window-${action}`}
      // Never takes the focus from the panels or the tiles on a click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => windowControl(action)}
      className={`${button} ${className}`}
    >
      <Icon>{children}</Icon>
    </button>
  )
}

/**
 * The window's title strip (ADR-0045): the app's name and where it is, and the
 * window's minimize, maximize and close buttons, drawn by the page in the
 * theme (Windows; main creates the window without a title bar). It is the
 * window's drag handle; a double-click maximizes. Always rendered, so the
 * app's grid keeps its rows; it has no height where the OS draws the frame
 * and in full screen (styles.css `.title-bar`).
 */
export function TitleBar({ title, detail, controls, rail = true, mark = false }: TitleBarProps) {
  const visible = useTitleBarShown()
  const maximized = useWindowFrameStore((s) => s.maximized)
  const minimizable = useWindowFrameStore((s) => s.minimizable)
  const maximizable = useWindowFrameStore((s) => s.maximizable)
  // Hidden by the app switch: no drag area over the shown app's buttons (styles.css).
  const inert = useWindowFrameStore((s) => !s.shown) || undefined
  // The full-window overlays and the loading curtain start below the strip.
  useEffect(() => {
    const root = document.documentElement
    if (visible) root.dataset.titleBar = ""
    else delete root.dataset.titleBar
  }, [visible])
  return (
    <>
      {rail && (
        <div
          aria-hidden="true"
          className="title-bar-mark bg-chrome"
          data-testid="title-bar-mark"
          data-inert={inert}
        >
          <img
            src={markUrl}
            alt=""
            width={20}
            height={20}
            draggable={false}
            className="title-bar-mark-img"
          />
        </div>
      )}
      <header
        data-testid="title-bar"
        data-inert={inert}
        aria-hidden={!visible || undefined}
        // Next to the mark the name needs no indent; alone (no rail) it keeps one from the window's edge.
        className={`title-bar flex min-w-0 shrink-0 items-center gap-2 bg-chrome text-xs select-none ${rail ? "" : "pl-3"}`}
      >
        {mark && !rail && (
          <img
            src={markUrl}
            alt=""
            width={16}
            height={16}
            draggable={false}
            className="title-bar-mark-img shrink-0"
            data-testid="title-bar-mark"
          />
        )}
        <span className="title-bar-name shrink-0 font-medium text-text">{title}</span>
        {detail && (
          <span
            className="title-bar-detail min-w-0 truncate text-muted"
            data-testid="title-bar-detail"
          >
            {detail}
          </span>
        )}
        {visible && (
          <div className="title-bar-controls ml-auto flex shrink-0 items-center gap-1">
            {controls && (
              <>
                {controls}
                <TitleBarDivider />
              </>
            )}
            <div role="group" aria-label={t("Window")} className="flex gap-1">
              {/* Only the buttons this window has: a modal settings window has Close only. */}
              {minimizable && (
                <ControlButton action="minimize" label={t("Minimize")}>
                  <path d="M3 7.5h8" />
                </ControlButton>
              )}
              {maximizable && (
                <ControlButton
                  action="toggleMaximize"
                  label={maximized ? t("Restore") : t("Maximize")}
                >
                  {maximized ? (
                    <>
                      <rect x="2.5" y="4.5" width="7" height="7" rx="1.75" />
                      <path d="M5 2.5h4.25a2.25 2.25 0 0 1 2.25 2.25V9" />
                    </>
                  ) : (
                    <rect x="2.5" y="2.5" width="9" height="9" rx="2.25" />
                  )}
                </ControlButton>
              )}
              <ControlButton
                action="close"
                label={t("Close")}
                className="hover:bg-danger hover:text-white"
              >
                <path d="M3.75 3.75l6.5 6.5M10.25 3.75l-6.5 6.5" />
              </ControlButton>
            </div>
          </div>
        )}
      </header>
    </>
  )
}
