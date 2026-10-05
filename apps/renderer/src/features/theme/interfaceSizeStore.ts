import { create } from "zustand"

export type InterfaceSize = "small" | "medium" | "large"

export const INTERFACE_SIZE_SCALE: Record<InterfaceSize, number> = {
  small: 0.875,
  medium: 1,
  large: 1.125,
}

const STORAGE_KEY = "fastview.interfaceSize"
const DEFAULT_INTERFACE_SIZE: InterfaceSize = "medium"

function isInterfaceSize(value: unknown): value is InterfaceSize {
  return value === "small" || value === "medium" || value === "large"
}

function readInterfaceSize(): InterfaceSize {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isInterfaceSize(value) ? value : DEFAULT_INTERFACE_SIZE
  } catch {
    return DEFAULT_INTERFACE_SIZE
  }
}

function applyInterfaceSize(size: InterfaceSize): void {
  document.documentElement.dataset.interfaceSize = size
}

interface InterfaceSizeState {
  size: InterfaceSize
  setSize(size: InterfaceSize): void
}

export const useInterfaceSizeStore = create<InterfaceSizeState>((set) => ({
  size: DEFAULT_INTERFACE_SIZE,
  setSize(size) {
    try {
      localStorage.setItem(STORAGE_KEY, size)
    } catch {
      // storage unavailable; the setting lasts for this session only
    }
    applyInterfaceSize(size)
    set({ size })
  },
}))

/** Apply the stored size before React renders, so layout spacing starts consistently. */
export function initInterfaceSize(): void {
  const size = readInterfaceSize()
  useInterfaceSizeStore.setState({ size })
  applyInterfaceSize(size)
}
