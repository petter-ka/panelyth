/// <reference types="vite/client" />
import type { CommanderApi } from "@fastview/contracts"

declare global {
  interface Window {
    fastview?: CommanderApi
  }
}
