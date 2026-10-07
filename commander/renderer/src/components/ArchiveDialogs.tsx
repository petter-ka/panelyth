import type { ArchiveWarning } from "@fastview/contracts"
import { Button, DialogWindow } from "@fastview/ui"
import { useState } from "react"
import {
  closePack,
  closeUnpack,
  FORMATS,
  LEVELS,
  startPack,
  startUnpack,
  updatePack,
  updateUnpack,
  useArchivesStore,
  type PackDialogState,
  type UnpackDialogState,
} from "../features/archives"
import { POLICIES } from "../features/files"
import { formatBytes } from "../features/format"

const field =
  "h-8 w-full rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent"

const WARNING_TEXT: Record<ArchiveWarning, string> = {
  space: "The extracted files need more space than the destination drive has free.",
  ratio:
    "The archive expands to more than 100 times its size. It may be a zip bomb; extract it only if you trust it.",
}

/** The archive warnings of ADR-0030, shown before anything is written. */
export function ArchiveWarnings({ warnings }: { warnings: readonly ArchiveWarning[] }) {
  if (warnings.length === 0) return null
  return (
    <ul role="alert" data-testid="archive-warnings" className="flex flex-col gap-1 text-danger">
      {warnings.map((w) => (
        <li key={w}>{WARNING_TEXT[w]}</li>
      ))}
    </ul>
  )
}

function Destination({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted">Into the folder</span>
      <input
        aria-label="Destination"
        className={field}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function Policy({
  value,
  onChange,
}: {
  value: PackDialogState["conflict"]
  onChange(v: PackDialogState["conflict"]): void
}) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-muted">If the name exists</span>
      <select
        aria-label="If the name exists"
        className={field}
        value={value}
        onChange={(e) => onChange(e.target.value as PackDialogState["conflict"])}
      >
        {POLICIES.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Alt+F5 (Stage C07): name, format, level, "delete originals afterwards". */
export function PackDialog() {
  const p = useArchivesStore((s) => s.pack)
  if (!p) return null
  return <PackForm key={`${p.side}-${p.source.queryId}-${p.source.version}`} p={p} />
}

function PackForm({ p }: { p: PackDialogState }) {
  const sevenZip = useArchivesStore((s) => s.sevenZip)
  const [busy, setBusy] = useState(false)
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closePack()
      }}
      title={`Pack ${p.what}`}
      contentClassName="w-[min(34rem,calc(100vw-2rem))]"
    >
      <form
        className="flex flex-col gap-3 text-xs"
        data-testid="pack-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void startPack().finally(() => setBusy(false))
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted">Archive name</span>
          <input
            aria-label="Archive name"
            className={field}
            value={p.name}
            spellCheck={false}
            autoFocus
            onChange={(e) => updatePack({ name: e.target.value })}
            onFocus={(e) => {
              // The name without the archive extension is selected.
              const dot = e.target.value.indexOf(".")
              e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
            }}
          />
        </label>
        <Destination
          value={p.destination}
          onChange={(destination) => updatePack({ destination })}
        />
        <div className="flex gap-3">
          <fieldset className="flex flex-1 flex-col gap-1">
            <legend className="mb-1 text-muted">Format</legend>
            {FORMATS.map((f) => {
              const disabled = f.value === "7z" && sevenZip !== true
              return (
                <label
                  key={f.value}
                  className={`flex items-center gap-2 ${disabled ? "text-muted" : ""}`}
                  title={disabled ? "Needs 7-Zip, which was not found" : undefined}
                >
                  <input
                    type="radio"
                    name="format"
                    value={f.value}
                    checked={p.format === f.value}
                    disabled={disabled}
                    onChange={() => updatePack({ format: f.value })}
                  />
                  {f.label}
                </label>
              )
            })}
          </fieldset>
          <div className="flex flex-1 flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-muted">Compression</span>
              <select
                aria-label="Compression"
                className={field}
                value={p.level}
                onChange={(e) => updatePack({ level: Number(e.target.value) })}
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <Policy value={p.conflict} onChange={(conflict) => updatePack({ conflict })} />
          </div>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={p.deleteOriginals}
            onChange={(e) => updatePack({ deleteOriginals: e.target.checked })}
          />
          Delete the originals after packing (move into the archive)
        </label>
        {p.error && (
          <p role="alert" className="text-danger">
            {p.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closePack}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Pack
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}

/** Alt+F9 (Stage C07): whole archives into a folder, each into its own on request. */
export function UnpackDialog() {
  const u = useArchivesStore((s) => s.unpack)
  if (!u) return null
  return <UnpackForm key={`${u.side}-${u.source.queryId}-${u.source.version}`} u={u} />
}

function UnpackForm({ u }: { u: UnpackDialogState }) {
  const [busy, setBusy] = useState(false)
  const size =
    u.files === null || u.bytes === null
      ? "Checking the size…"
      : `${u.files.toLocaleString()} ${u.files === 1 ? "file" : "files"}, ${formatBytes(u.bytes)}`
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeUnpack()
      }}
      title={`Unpack ${u.what}`}
      contentClassName="w-[min(34rem,calc(100vw-2rem))]"
    >
      <form
        className="flex flex-col gap-3 text-xs"
        data-testid="unpack-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void startUnpack().finally(() => setBusy(false))
        }}
      >
        <Destination
          value={u.destination}
          onChange={(destination) => updateUnpack({ destination })}
        />
        <p className="text-muted" data-testid="unpack-size">
          {size}
        </p>
        <div className="flex gap-3">
          <Policy value={u.conflict} onChange={(conflict) => updateUnpack({ conflict })} />
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={u.subfolders}
            onChange={(e) => updateUnpack({ subfolders: e.target.checked })}
          />
          Unpack each archive into its own folder
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={u.links}
            onChange={(e) => updateUnpack({ links: e.target.checked })}
          />
          Create links stored in the archives (only those that stay inside the folder)
        </label>
        <ArchiveWarnings warnings={u.warnings} />
        {u.error && (
          <p role="alert" className="text-danger">
            {u.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeUnpack}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy} autoFocus>
            {u.warnings.length > 0 ? "Unpack anyway" : "Unpack"}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}
