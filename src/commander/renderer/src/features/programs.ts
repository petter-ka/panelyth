import type { ContentItem, ExternalProgram } from "@panelyth/contracts"
import { programRefusal } from "@panelyth/ui"
import { bridge } from "../bridge"
import { notice } from "./files"
import { pageStoreOf, parentRows, useListingStore } from "./listing"
import type { Side } from "./panels"

/**
 * The entry "Open with" programs (ADR-0044) can be given: the one under the
 * cursor, in a folder of this computer. Entries inside an archive or on a
 * server have no path a program could open.
 */
export function programEntry(side: Side): ContentItem | null {
  const p = useListingStore.getState()[side]
  if (p.archive || p.remote) return null
  return pageStoreOf(side).getItem(p.cursor - parentRows(p)) ?? null
}

/** Main starts the program with the entry; a refusal shows as a notice. */
export function openWithProgram(program: ExternalProgram, entryId: number): void {
  void bridge
    .openWithProgram(program.id, entryId)
    .catch((error: unknown) => notice(programRefusal(error, program.name)))
}
