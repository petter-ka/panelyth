// Settings → Editor (Stage 12): what a save defaults to and what surrounds
// the picture. Stored in library.db under "viewer.editor".
import {
  DEFAULT_JPEG_QUALITY,
  MAX_JPEG_QUALITY,
  METADATA_POLICIES,
  MIN_JPEG_QUALITY,
  SAVE_TARGETS,
  type MetadataPolicy,
  type SaveTarget,
} from "@panelyth/contracts"
import { create } from "zustand"
import { bridge } from "../../bridge"
import { useLibraryStore } from "../library/libraryStore"

export const EDITOR_SETTINGS_KEY = "viewer.editor"

/** What surrounds the picture: neutral gray (18 %, for judging color), or black, white or the interface's own tone. */
export const SURROUNDS = ["gray", "black", "white", "theme"] as const
export type Surround = (typeof SURROUNDS)[number]

export interface EditorSettings {
  v: 1
  /** What the Save button does first. */
  saveTarget: SaveTarget
  jpegQuality: number
  metadata: MetadataPolicy
  surround: Surround
  /** The right panel (histogram, tool options, info) is shown. */
  panel: boolean
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  v: 1,
  saveTarget: "copy",
  jpegQuality: DEFAULT_JPEG_QUALITY,
  metadata: "keep",
  surround: "gray",
  panel: true,
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback

/** Validates untrusted persisted data. */
export function parseEditorSettings(value: unknown): EditorSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return DEFAULT_EDITOR_SETTINGS
  const v = value as Record<string, unknown>
  const q = v.jpegQuality
  return {
    v: 1,
    saveTarget: oneOf(SAVE_TARGETS, v.saveTarget, DEFAULT_EDITOR_SETTINGS.saveTarget),
    jpegQuality:
      Number.isSafeInteger(q) &&
      (q as number) >= MIN_JPEG_QUALITY &&
      (q as number) <= MAX_JPEG_QUALITY
        ? (q as number)
        : DEFAULT_EDITOR_SETTINGS.jpegQuality,
    metadata: oneOf(METADATA_POLICIES, v.metadata, DEFAULT_EDITOR_SETTINGS.metadata),
    surround: oneOf(SURROUNDS, v.surround, DEFAULT_EDITOR_SETTINGS.surround),
    panel: v.panel !== false,
  }
}

interface State {
  settings: EditorSettings
  set<K extends keyof Omit<EditorSettings, "v">>(key: K, value: EditorSettings[K]): void
}

export const useEditorSettings = create<State>((set, get) => ({
  settings: DEFAULT_EDITOR_SETTINGS,
  set(key, value) {
    const settings = { ...get().settings, [key]: value, v: 1 } as EditorSettings
    set({ settings })
    if (useLibraryStore.getState().loaded)
      void bridge.setSetting(EDITOR_SETTINGS_KEY, settings).catch(() => undefined)
  },
}))

/** Applies saved settings after each successful library load. */
export function startEditorSettingsPersistence(): () => void {
  const load = (settings: Record<string, unknown>): void =>
    useEditorSettings.setState({ settings: parseEditorSettings(settings[EDITOR_SETTINGS_KEY]) })
  if (useLibraryStore.getState().loaded) load(useLibraryStore.getState().settings)
  return useLibraryStore.subscribe((s, prev) => {
    if (s.loaded && (!prev.loaded || s.settings !== prev.settings)) load(s.settings)
  })
}

/** The CSS color of a surround. */
export function surroundColor(surround: Surround): string {
  switch (surround) {
    case "gray":
      // 18 % gray in sRGB, the same in both themes.
      return "#777777"
    case "black":
      return "#000000"
    case "white":
      return "#ffffff"
    case "theme":
      return "var(--color-canvas)"
  }
}
