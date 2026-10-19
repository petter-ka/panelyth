import { programsFor, type ExternalProgram } from "@panelyth/contracts"
import { usePrograms } from "@panelyth/renderer-core"
import { programRefusal } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import { bridge } from "../bridge"
import { notify } from "../features/clipboard/clipboard"
import { ContextMenuItem } from "./ui/menu"

/** What a program opens: an indexed entry, or a folder of the folder tree by its path. */
export type ProgramTarget = { entryId: number; folder: boolean } | { path: string }

/** Main starts the program with the entry (ADR-0044); a refusal shows in the status line. */
export function openWithProgram(program: ExternalProgram, target: ProgramTarget): void {
  const started =
    "path" in target
      ? bridge.openFolderWithProgram(program.id, target.path)
      : bridge.openWithProgram(program.id, target.entryId)
  void started.catch((error: unknown) => notify(programRefusal(error, program.name), "error"))
}

/** "Open with <program>": the programs from Settings → Open with for the target's kind. */
export function ProgramMenuItems({ target }: { target: ProgramTarget }) {
  const programs = usePrograms((s) => s.programs)
  const folder = "path" in target || target.folder
  return programsFor(programs, folder).map((program) => (
    <ContextMenuItem
      key={program.id}
      onSelect={() => openWithProgram(program, target)}
      data-testid="menu-open-with-program"
    >
      {t("Open with {name}", { name: program.name })}
    </ContextMenuItem>
  ))
}
