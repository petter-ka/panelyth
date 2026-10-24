import { create } from "zustand"

export type WindowControlAction = "minimize" | "toggleMaximize" | "close"

export interface WindowFrameState {
  maximized: boolean
  fullScreen: boolean
}

/** What an app's bridge gives the title strip (ADR-0045). */
export interface WindowFramePort {
  /** This view draws the title strip (main's renderer argument; Windows). */
  titleBar: boolean
  /** The frame, whether this app is the one on screen, and the buttons its window has. */
  state(): Promise<
    WindowFrameState & { shown: boolean; minimizable?: boolean; maximizable?: boolean }
  >
  control(action: WindowControlAction): Promise<void>
  onState(listener: (state: WindowFrameState) => void): () => void
  /** This app was shown or hidden by the app switch. */
  onShown(listener: (shown: boolean) => void): () => void
}

interface FrameStore extends WindowFrameState {
  titleBar: boolean
  /**
   * This app is the one on screen. A hidden app's strip still lies under the
   * shown one's (the viewer's page is under the other apps' views), and Windows
   * would take its drag area over the shown app's buttons: it gives it up.
   */
  shown: boolean
  /** The window's own buttons (a modal settings window has Close only). */
  minimizable: boolean
  maximizable: boolean
}

export const useWindowFrameStore = create<FrameStore>(() => ({
  titleBar: false,
  maximized: false,
  fullScreen: false,
  shown: true,
  minimizable: true,
  maximizable: true,
}))

/**
 * True while the title strip is on screen (Windows, not in full screen): the
 * controls it repeats can step aside.
 */
export const useTitleBarShown = (): boolean =>
  useWindowFrameStore((s) => s.titleBar && !s.fullScreen)

let port: WindowFramePort | null = null

/**
 * Connects the title strip to the app's bridge: whether it is drawn, and the
 * window's maximized and full-screen state as main reports it.
 */
export function connectWindowFrame(next: WindowFramePort): () => void {
  port = next
  useWindowFrameStore.setState({ titleBar: next.titleBar })
  if (!next.titleBar) return () => undefined
  // An event that came before the answer is newer than it.
  let heardState = false
  let heardShown = false
  const offState = next.onState((state) => {
    heardState = true
    useWindowFrameStore.setState(state)
  })
  const offShown = next.onShown((shown) => {
    heardShown = true
    useWindowFrameStore.setState({ shown })
  })
  void next
    .state()
    .then(({ maximized, fullScreen, shown, minimizable, maximizable }) => {
      if (!heardState) useWindowFrameStore.setState({ maximized, fullScreen })
      if (!heardShown) useWindowFrameStore.setState({ shown })
      useWindowFrameStore.setState({
        minimizable: minimizable !== false,
        maximizable: maximizable !== false,
      })
    })
    .catch(() => undefined)
  return () => {
    offState()
    offShown()
    if (port === next) port = null
  }
}

/** A window button of the title strip. */
export function windowControl(action: WindowControlAction): void {
  void port?.control(action).catch(() => undefined)
}
