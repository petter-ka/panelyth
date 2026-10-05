import type { FastViewApi } from "@fastview/contracts"

declare global {
  interface Window {
    fastview?: FastViewApi
  }
}
