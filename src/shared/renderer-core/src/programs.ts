import {
  readPrograms,
  SHARED_PROGRAMS_KEY,
  type ExternalProgram,
  type ProgramEdit,
  type ProgramsResult,
} from "@panelyth/contracts"
import { create } from "zustand"

/**
 * The "Open with" programs (`shared.programs`, ADR-0044) both apps list in
 * their context menus. Main alone writes them; a change made in one app's
 * Settings reaches every view through the settings.changed event.
 */
export const usePrograms = create<{ programs: ExternalProgram[] }>(() => ({ programs: [] }))

export interface ProgramsPort {
  loadSettings(): Promise<Record<string, unknown>>
  onSettingChanged(listener: (key: string, value: unknown) => void): () => void
  /** Main's dialog picks a program and adds it (throws PanelythError). */
  add?(): Promise<ProgramsResult>
  update?(programs: ProgramEdit[]): Promise<ProgramsResult>
}

let actions: Pick<ProgramsPort, "add" | "update"> = {}

/** Loads the programs and follows changes; `add` and `update` are where Settings is shown. */
export function startProgramsSync(port: ProgramsPort): () => void {
  actions = { ...(port.add && { add: port.add }), ...(port.update && { update: port.update }) }
  void port
    .loadSettings()
    .then((settings) =>
      usePrograms.setState({ programs: readPrograms(settings[SHARED_PROGRAMS_KEY]) }),
    )
    .catch(() => undefined)
  return port.onSettingChanged((key, value) => {
    if (key === SHARED_PROGRAMS_KEY) usePrograms.setState({ programs: readPrograms(value) })
  })
}

const apply = (result: ProgramsResult): void => usePrograms.setState({ programs: result.programs })

/** Opens main's dialog; the id of the program added, or null when cancelled. */
export async function addProgram(): Promise<string | null> {
  if (!actions.add) return null
  const result = await actions.add()
  apply(result)
  return result.added ?? null
}

/** Saves names, targets and the order; a program left out is removed. */
export async function updatePrograms(programs: readonly ExternalProgram[]): Promise<void> {
  if (!actions.update) return
  // Shown at once; main's answer (or the event) settles it.
  const before = usePrograms.getState().programs
  usePrograms.setState({ programs: [...programs] })
  try {
    apply(await actions.update(programs.map(({ id, name, target }) => ({ id, name, target }))))
  } catch (error) {
    usePrograms.setState({ programs: before })
    throw error
  }
}
