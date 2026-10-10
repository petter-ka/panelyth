import {
  Children,
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"

const TARGET = "[data-tooltip-content]"
const DEFAULT_DELAY = 500

type TooltipSide = "auto" | "top" | "bottom" | "left" | "right"

interface TooltipTriggerProps {
  disabled?: boolean
  style?: CSSProperties
  "data-tooltip-content"?: string
  "data-tooltip-side"?: TooltipSide
}

interface TooltipProps {
  content?: string | null | undefined
  side?: Exclude<TooltipSide, "auto">
  children: ReactElement
}

interface TooltipProviderProps {
  children: ReactNode
  delay?: number
}

interface ActiveTooltip {
  target: HTMLElement
  content: string
  side: TooltipSide
}

interface TooltipPosition {
  left: number
  top: number
  side: Exclude<TooltipSide, "auto">
  ready: boolean
}

function tooltipTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const candidate = target.closest<HTMLElement>(TARGET)
  return candidate?.dataset.tooltipContent ? candidate : null
}

function arrowStyle(side: TooltipPosition["side"], layer: "border" | "fill"): CSSProperties {
  const size = layer === "border" ? 7 : 6
  const color = layer === "border" ? "var(--border)" : "var(--text)"
  const transparent = `${size}px solid transparent`

  switch (side) {
    case "top":
      return {
        position: "absolute",
        left: "50%",
        bottom: -size,
        transform: "translateX(-50%)",
        width: 0,
        height: 0,
        borderLeft: transparent,
        borderRight: transparent,
        borderTop: `${size}px solid ${color}`,
      }
    case "bottom":
      return {
        position: "absolute",
        left: "50%",
        top: -size,
        transform: "translateX(-50%)",
        width: 0,
        height: 0,
        borderLeft: transparent,
        borderRight: transparent,
        borderBottom: `${size}px solid ${color}`,
      }
    case "right":
      return {
        position: "absolute",
        top: "50%",
        left: -size,
        transform: "translateY(-50%)",
        width: 0,
        height: 0,
        borderTop: transparent,
        borderBottom: transparent,
        borderRight: `${size}px solid ${color}`,
      }
    case "left":
      return {
        position: "absolute",
        top: "50%",
        right: -size,
        transform: "translateY(-50%)",
        width: 0,
        height: 0,
        borderTop: transparent,
        borderBottom: transparent,
        borderLeft: `${size}px solid ${color}`,
      }
  }
}

/** Adds a tooltip hint without putting a native `title` attribute in the DOM. */
export function Tooltip({ content, side, children }: TooltipProps) {
  const element = Children.only(children) as ReactElement<TooltipTriggerProps>
  if (!content) return element

  const marked = cloneElement(element, {
    "data-tooltip-content": content,
    ...(side && { "data-tooltip-side": side }),
    ...(element.props.disabled && {
      style: { ...element.props.style, pointerEvents: "none" },
    }),
  })

  // Disabled controls do not reliably receive pointer events. Put the hint on
  // a small hit target around them; enabled controls keep their exact layout.
  return element.props.disabled ? (
    <span className="inline-flex" data-tooltip-content={content} data-tooltip-side={side}>
      {marked}
    </span>
  ) : (
    marked
  )
}

/** One delegated, delayed tooltip for an app window, including its portals. */
export function TooltipProvider({ children, delay = DEFAULT_DELAY }: TooltipProviderProps) {
  const [active, setActive] = useState<ActiveTooltip | null>(null)
  const [position, setPosition] = useState<TooltipPosition>({
    left: 0,
    top: 0,
    side: "top",
    ready: false,
  })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTarget = useRef<HTMLElement | null>(null)
  const visibleTarget = useRef<HTMLElement | null>(null)
  const pointerTarget = useRef<HTMLElement | null>(null)
  const focusTarget = useRef<HTMLElement | null>(null)
  const popup = useRef<HTMLDivElement | null>(null)
  const id = useId()

  const cancelPending = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    pendingTarget.current = null
  }, [])

  const activate = useCallback(
    (target: HTMLElement) => {
      if (visibleTarget.current === target || pendingTarget.current === target) return
      cancelPending()
      if (visibleTarget.current) {
        visibleTarget.current = null
        setActive(null)
      }
      pendingTarget.current = target
      timer.current = setTimeout(() => {
        timer.current = null
        if (pendingTarget.current !== target) return
        pendingTarget.current = null
        const content = target.dataset.tooltipContent
        if (!content || !target.isConnected) return
        visibleTarget.current = target
        const side = target.dataset.tooltipSide
        setActive({
          target,
          content,
          side:
            side === "top" || side === "bottom" || side === "left" || side === "right"
              ? side
              : "auto",
        })
      }, delay)
    },
    [cancelPending, delay],
  )

  const deactivate = useCallback(
    (target: HTMLElement | null) => {
      if (target && pendingTarget.current === target) cancelPending()
      if (target && visibleTarget.current === target) {
        visibleTarget.current = null
        setActive(null)
      }
    },
    [cancelPending],
  )

  const updateActiveTarget = useCallback(() => {
    const target = pointerTarget.current ?? focusTarget.current
    if (target) activate(target)
    else {
      deactivate(pendingTarget.current)
      deactivate(visibleTarget.current)
    }
  }, [activate, deactivate])

  useEffect(() => {
    const onPointerOver = (event: PointerEvent): void => {
      const from = tooltipTarget(event.relatedTarget)
      const to = tooltipTarget(event.target)
      if (from === to) return
      pointerTarget.current = to
      updateActiveTarget()
    }
    const onPointerOut = (event: PointerEvent): void => {
      const from = tooltipTarget(event.target)
      const to = tooltipTarget(event.relatedTarget)
      if (from === to) return
      if (pointerTarget.current === from) pointerTarget.current = null
      updateActiveTarget()
    }
    const onFocusIn = (event: FocusEvent): void => {
      focusTarget.current = tooltipTarget(event.target)
      updateActiveTarget()
    }
    const onFocusOut = (event: FocusEvent): void => {
      const from = tooltipTarget(event.target)
      if (focusTarget.current === from) focusTarget.current = null
      updateActiveTarget()
    }

    document.addEventListener("pointerover", onPointerOver)
    document.addEventListener("pointerout", onPointerOut)
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("focusout", onFocusOut)
    return () => {
      document.removeEventListener("pointerover", onPointerOver)
      document.removeEventListener("pointerout", onPointerOut)
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("focusout", onFocusOut)
      cancelPending()
    }
  }, [cancelPending, updateActiveTarget])

  useEffect(() => {
    if (!active) return
    const previous = active.target.getAttribute("aria-describedby")
    const describedBy = [...new Set([...(previous?.split(/\s+/) ?? []), id])]
      .filter(Boolean)
      .join(" ")
    active.target.setAttribute("aria-describedby", describedBy)
    return () => {
      const current = active.target.getAttribute("aria-describedby")?.split(/\s+/) ?? []
      const next = current.filter((value) => value !== id).join(" ")
      if (next) active.target.setAttribute("aria-describedby", next)
      else active.target.removeAttribute("aria-describedby")
    }
  }, [active, id])

  const positionPopup = useCallback(() => {
    const anchor = active?.target
    const tooltip = popup.current
    if (!active || !anchor || !tooltip) return
    if (!anchor.isConnected) {
      deactivate(anchor)
      return
    }

    const anchorRect = anchor.getBoundingClientRect()
    const popupRect = tooltip.getBoundingClientRect()
    let side: TooltipPosition["side"]
    if (active.side === "left" || active.side === "right") {
      const fitsLeft = anchorRect.left - popupRect.width - 16 >= 0
      const fitsRight = anchorRect.right + popupRect.width + 16 <= window.innerWidth
      side =
        active.side === "right"
          ? fitsRight || !fitsLeft
            ? "right"
            : "left"
          : fitsLeft || !fitsRight
            ? "left"
            : "right"
    } else if (active.side === "top" || active.side === "bottom") {
      side = active.side
    } else {
      side = anchorRect.top - popupRect.height - 8 >= 8 ? "top" : "bottom"
    }

    let left: number
    let top: number
    if (side === "right" || side === "left") {
      const idealLeft =
        side === "right" ? anchorRect.right + 8 : anchorRect.left - popupRect.width - 8
      left = Math.min(Math.max(idealLeft, 8), window.innerWidth - popupRect.width - 8)
      top = Math.min(
        Math.max(anchorRect.top + anchorRect.height / 2, popupRect.height / 2 + 8),
        window.innerHeight - popupRect.height / 2 - 8,
      )
    } else {
      const halfWidth = popupRect.width / 2
      left = Math.min(
        Math.max(anchorRect.left + anchorRect.width / 2, halfWidth + 8),
        window.innerWidth - halfWidth - 8,
      )
      top = side === "top" ? anchorRect.top - 8 : anchorRect.bottom + 8
    }
    setPosition({ left, top, side, ready: true })
  }, [active, deactivate])

  useLayoutEffect(() => {
    // The popup unmounts while inactive; the next activation positions it before paint.
    if (!active) return
    positionPopup()
    window.addEventListener("resize", positionPopup)
    window.addEventListener("scroll", positionPopup, true)
    return () => {
      window.removeEventListener("resize", positionPopup)
      window.removeEventListener("scroll", positionPopup, true)
    }
  }, [active, positionPopup])

  return (
    <>
      {children}
      {active &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="tooltip"
            data-tooltip-popup
            className="pointer-events-none fixed z-[9999] max-h-[calc(100vh-1rem)] max-w-[min(22rem,calc(100vw-1rem))] break-words whitespace-pre-line rounded-md border border-border bg-text px-2 py-1 text-[0.6875rem] leading-snug font-bold text-chrome"
            style={{
              left: position.left,
              top: position.top,
              transform:
                position.side === "top"
                  ? "translate(-50%, -100%)"
                  : position.side === "bottom"
                    ? "translate(-50%, 0)"
                    : position.side === "right"
                      ? "translate(0, -50%)"
                      : "translate(-100%, -50%)",
              visibility: position.ready ? "visible" : "hidden",
            }}
          >
            <div className="max-h-[calc(100vh-2rem)] overflow-y-auto break-words whitespace-pre-line">
              {active.content}
            </div>
            <span aria-hidden="true" style={arrowStyle(position.side, "border")} />
            <span aria-hidden="true" style={arrowStyle(position.side, "fill")} />
          </div>,
          document.body,
        )}
    </>
  )
}
