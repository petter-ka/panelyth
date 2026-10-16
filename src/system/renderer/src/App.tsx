import {
  SharedSettingsDialog,
  AppLoadingOverlay,
  AppSwitcher,
  GlyphSprite,
  TooltipProvider,
} from "@panelyth/ui"
import type { AppId } from "@panelyth/contracts"
import { bridge } from "./bridge"
import { CpuCard, GpuCard, Header, MemoryCard, StorageCard } from "./components/Dashboard"
import { SearchCard } from "./components/SearchCard"
import { openSettings, setSettingsOpen, useSettingsStore } from "./features/settings"

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
const SWITCH_SHORTCUT = IS_MAC ? "⌘⇧M" : "Ctrl+Shift+M"

const switchTo = (to: AppId): void => void bridge.switchTo(to).catch(() => undefined)

/**
 * Panelyth System (ADR-0042): the rail, then the dashboard: the computer,
 * its processor, memory, graphics and volumes, and a search over the volumes.
 */
export function App() {
  const settingsOpen = useSettingsStore((s) => s.open)
  return (
    <TooltipProvider>
      <GlyphSprite />
      <div className="glass-shell relative grid h-full grid-cols-[2.75rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
        <AppSwitcher
          current="system"
          shortcut={SWITCH_SHORTCUT}
          onSwitch={switchTo}
          onSettings={openSettings}
        />
        <main
          className="glass-stack min-h-0 min-w-0 overflow-y-auto bg-canvas"
          data-testid="system-dashboard"
        >
          <div className="mx-auto flex max-w-7xl flex-col gap-4 p-5">
            <Header />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <CpuCard />
              <MemoryCard />
              <GpuCard />
              <StorageCard />
              <SearchCard />
            </div>
          </div>
        </main>
        <AppLoadingOverlay app="system" />
      </div>
      <SharedSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        currentApp="system"
        showGeneral
        settingsReady
        appSettings={null}
        onOpenShortcuts={() => undefined}
      />
    </TooltipProvider>
  )
}
