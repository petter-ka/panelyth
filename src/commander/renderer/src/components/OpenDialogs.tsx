import { Button, DialogWindow } from "@panelyth/ui"
import { useState } from "react"
import {
  cancelProgram,
  closeNewFile,
  createTextFile,
  runConfirmedProgram,
  useOpenStore,
} from "../features/open"

const field =
  "h-8 w-full rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent"

/**
 * Enter on a program (ADR-0027, Stage C05): it runs only after this
 * confirmation, unless Settings → "Run programs with Enter" says otherwise.
 * Cancel has the focus, so a stray Enter never starts anything.
 */
export function ProgramDialog() {
  const p = useOpenStore((s) => s.program)
  if (!p) return null
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) cancelProgram()
      }}
      title="Run this program?"
      description={`${p.name} is a program. Run it only if you trust where it came from.`}
    >
      <div className="flex justify-end gap-2 text-xs" data-testid="program-dialog">
        <Button onClick={cancelProgram} autoFocus>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => void runConfirmedProgram()}>
          Run
        </Button>
      </div>
    </DialogWindow>
  )
}

/** Shift+F4: creates a text file in the panel's folder and opens it in the editor. */
export function NewFileDialog() {
  const n = useOpenStore((s) => s.newFile)
  const [name, setName] = useState("new.txt")
  if (!n) return null
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeNewFile()
      }}
      title="New text file"
      description="An existing file of that name opens as it is."
    >
      <form
        className="flex flex-col gap-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() !== "") void createTextFile(name)
        }}
      >
        <input
          aria-label="File name"
          className={field}
          value={name}
          spellCheck={false}
          aria-invalid={n.error !== null}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => {
            const dot = e.target.value.lastIndexOf(".")
            e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
          }}
          autoFocus
        />
        {n.error && (
          <p role="alert" className="text-danger">
            {n.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeNewFile}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={name.trim() === ""}>
            Create and edit
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}
