/// <reference types="vite/client" />
import type { SystemApi } from "@panelyth/contracts"

declare global {
  interface Window {
    panelyth?: SystemApi
  }
}
