import type { TextEditorApi } from "@panelyth/contracts"
import { unwrap } from "@panelyth/renderer-core"
import { connectWindowFrame } from "@panelyth/ui"

/**
 * The window's title strip (ADR-0045): on Windows main creates the editor
 * window without a title bar and the page draws it with its own minimize,
 * maximize and close (they act on this window only; main resolves it from the
 * sender). Elsewhere `titleBar` is false and the OS draws the frame.
 */
export function connectFrame(api: Pick<TextEditorApi, "frame" | "onEvent">): () => void {
  return connectWindowFrame({
    titleBar: api.frame.titleBar,
    state: () => unwrap(() => api.frame.state()),
    control: async (action) => {
      await api.frame.control(action)
    },
    onState: (listener) => api.onEvent("window.state", listener),
    // A window of its own is always the one on screen.
    onShown: () => () => undefined,
  })
}
