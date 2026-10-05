import { create } from "zustand"

export type ThemePreference =
  "system" | "light" | "dark" | "dark-purple" | "dark-brown" | "beige" | "light-brown"

export const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "dark-purple", label: "Dark purple" },
  { value: "dark-brown", label: "Dark brown" },
  { value: "beige", label: "Beige" },
  { value: "light-brown", label: "Light brown" },
]

const STORAGE_KEY = "fastview.theme"
/** Dark is the designed default: media reads best on a dark neutral surround. */
export const DEFAULT_THEME: ThemePreference = "dark"
const ORDER: readonly ThemePreference[] = ["dark", "light", "system"]

// The theme stays in localStorage only: it is needed before anything paints,
// before the sidecar (and library.db) is reachable. Other workspace
// preferences live in library.db (stages/05-filesystem-ux.md).
function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return THEME_OPTIONS.some((option) => option.value === value)
      ? (value as ThemePreference)
      : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

function writePreference(value: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // storage unavailable; preference lasts for this session only
  }
}

const systemDark = (): boolean =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false

function apply(preference: ThemePreference): void {
  const systemTheme = preference === "system" ? systemDark() : null
  const dark =
    preference === "dark" ||
    preference === "dark-purple" ||
    preference === "dark-brown" ||
    (preference === "system" && systemTheme === true)
  const theme = preference === "system" ? (systemTheme ? "dark" : "light") : preference
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.dataset.theme = theme
}

interface ThemeState {
  preference: ThemePreference
  setPreference(preference: ThemePreference): void
  cycle(): void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: DEFAULT_THEME,
  setPreference(preference) {
    writePreference(preference)
    apply(preference)
    set({ preference })
  },
  cycle() {
    const next = ORDER[(ORDER.indexOf(get().preference) + 1) % ORDER.length] ?? DEFAULT_THEME
    get().setPreference(next)
  },
}))

/** Applies the stored preference and follows OS changes while on "system". */
export function initTheme(): () => void {
  const preference = readPreference()
  useThemeStore.setState({ preference })
  apply(preference)
  const query = window.matchMedia?.("(prefers-color-scheme: dark)")
  const onChange = (): void => {
    if (useThemeStore.getState().preference === "system") apply("system")
  }
  query?.addEventListener("change", onChange)
  return () => query?.removeEventListener("change", onChange)
}
