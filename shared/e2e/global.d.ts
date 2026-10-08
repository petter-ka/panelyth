import type { PanelythApi } from "@panelyth/contracts"

declare global {
  interface Window {
    panelyth?: PanelythApi
  }
}
