import { TEXTEDIT_MAX_IMAGE_LINKS } from "@panelyth/contracts"
import { isLocalImageLink } from "./html"

// Read tokens for the pictures a document links to (ADR-0046): asked for in
// batches of at most 200 links, one batch after the other, and kept for the
// session. A link that named no picture is asked again after a save (the
// file may have appeared meanwhile).

export type ResolveBatch = (links: string[]) => Promise<{ link: string; src: string | null }[]>

export interface ImageResolver {
  /** The token of a link: a string, null (no picture there) or undefined (not known yet). */
  get(link: string): string | null | undefined
  /** Asks for the links not known yet; listeners hear when answers arrive. */
  request(links: readonly string[]): void
  /** Resolves every link (Preview): resolves when all answers are in. */
  resolveAll(links: readonly string[]): Promise<void>
  /** After a save: links that named nothing are asked again on their next request. */
  forgetMissing(): void
  onChange(listener: () => void): () => void
}

export function createImageResolver(resolve: ResolveBatch): ImageResolver {
  const cache = new Map<string, string | null>()
  const pending = new Set<string>()
  const queue: string[] = []
  const listeners = new Set<() => void>()
  let running: Promise<void> | null = null

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.splice(0, TEXTEDIT_MAX_IMAGE_LINKS)
      try {
        const answers = await resolve(batch)
        const got = new Map(answers.map((a) => [a.link, a.src]))
        for (const link of batch) cache.set(link, got.get(link) ?? null)
      } catch {
        // Unreachable sidecar: a placeholder now, asked again after the next save.
        for (const link of batch) cache.set(link, null)
      }
      for (const link of batch) pending.delete(link)
      for (const listener of listeners) listener()
    }
  }

  const start = (): Promise<void> => {
    if (!running) {
      running = Promise.resolve()
        .then(drain)
        .finally(() => {
          running = null
          // Links queued while the last batch was finishing.
          if (queue.length > 0) void start()
        })
    }
    return running
  }

  const enqueue = (links: readonly string[]): boolean => {
    let added = false
    for (const link of links) {
      if (!isLocalImageLink(link) || cache.has(link) || pending.has(link)) continue
      pending.add(link)
      queue.push(link)
      added = true
    }
    return added
  }

  return {
    get: (link) => cache.get(link),
    request(links) {
      if (enqueue(links)) void start()
    },
    async resolveAll(links) {
      enqueue(links)
      while (running || queue.length > 0) await start()
    },
    forgetMissing() {
      for (const [link, src] of cache) if (src === null) cache.delete(link)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
