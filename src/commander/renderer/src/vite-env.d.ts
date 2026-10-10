/// <reference types="vite/client" />
import type { CommanderApi } from "@panelyth/contracts"

declare global {
  interface Window {
    panelyth?: CommanderApi
  }
}
