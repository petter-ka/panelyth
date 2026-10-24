import { useSyncExternalStore } from "react"

/**
 * A small value outside React: the editor pushes derived values (the cursor,
 * the counts, the save state) and only the components that read one render.
 */
export interface Store<T> {
  get(): T
  set(patch: Partial<T>): void
  subscribe(listener: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(patch) {
      let changed = false
      for (const key in patch) {
        if (!Object.is(patch[key], state[key])) {
          changed = true
          break
        }
      }
      if (!changed) return
      state = { ...state, ...patch }
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** One value of a store; selectors return primitives or values the store keeps as they are. */
export function useStore<T, S>(store: Store<T>, select: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()))
}
