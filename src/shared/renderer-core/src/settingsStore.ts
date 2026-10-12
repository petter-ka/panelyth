import { create, type StoreApi, type UseBoundStore } from "zustand"

export interface SettingsState<T> {
  settings: T
  /** The app's settings dialog. */
  open: boolean
}

export interface SettingsStoreOptions<T> {
  defaults: T
  /** Validates a stored value; anything unknown falls back to the defaults. */
  read(value: unknown): T
  /** Persists the settings under the app's key in library.db (ADR-0031). */
  save(settings: T): void
}

export interface SettingsStore<T> {
  useStore: UseBoundStore<StoreApi<SettingsState<T>>>
  /** Changes the settings and saves them whole. */
  update(change: Partial<T>): void
  /** Applies the value stored in library.db; never saves. */
  load(value: unknown): void
  setOpen(open: boolean): void
  /** Tests. */
  reset(): void
}

/**
 * An app's own settings (the viewer's `viewer`, the commander's
 * `commander.settings`): one validated object, changed in memory at once and
 * written whole. What both apps share lives under `shared.*` in stores of
 * its own (the app switch here, the appearance in src/shared/ui).
 */
export function createSettingsStore<T extends object>(
  options: SettingsStoreOptions<T>,
): SettingsStore<T> {
  const useStore = create<SettingsState<T>>(() => ({ settings: options.defaults, open: false }))
  return {
    useStore,
    update(change) {
      const settings = { ...useStore.getState().settings, ...change }
      useStore.setState({ settings })
      options.save(settings)
    },
    load: (value) => useStore.setState({ settings: options.read(value) }),
    setOpen: (open) => useStore.setState({ open }),
    reset: () => useStore.setState({ settings: options.defaults, open: false }),
  }
}
