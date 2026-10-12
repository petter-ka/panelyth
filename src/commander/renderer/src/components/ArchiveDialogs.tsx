import type { ArchiveWarning } from "@panelyth/contracts"
import { Button, DialogWindow, fieldClass as field } from "@panelyth/ui"
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
import { msg, t } from "@panelyth/i18n"

const WARNING_TEXT: Record<ArchiveWarning, string> = {
  space: msg("The extracted files need more space than the destination drive has free."),
  ratio: msg(
    "The archive expands to more than 100 times its size. It may be a zip bomb; extract it only if you trust it.",
  ),
}

/** The archive warnings of ADR-0030, shown before anything is written. */
export function ArchiveWarnings({ warnings }: { warnings: readonly ArchiveWarning[] }) {
  if (warnings.length === 0) return null
  return (
    <ul role="alert" data-testid="archive-warnings" className="flex flex-col gap-1 text-danger">
      {warnings.map((w) => (
        <li key={w}>{t(WARNING_TEXT[w])}</li>
      ))}
    </ul>
  )
}

function Destination({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted">{t("Into the folder")}</span>
      <input
        aria-label={t("Destination")}
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
      <span className="text-muted">{t("If the name exists")}</span>
      <select
        aria-label={t("If the name exists")}
        className={field}
        value={value}
        onChange={(e) => onChange(e.target.value as PackDialogState["conflict"])}
      >
        {POLICIES.map((p) => (
          <option key={p.value} value={p.value}>
            {t(p.label)}
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
      title={t("Pack {what}", { what: p.what })}
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
          <span className="text-muted">{t("Archive name")}</span>
          <input
            aria-label={t("Archive name")}
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
            <legend className="mb-1 text-muted">{t("Format")}</legend>
            {FORMATS.map((f) => {
              const disabled = f.value === "7z" && sevenZip !== true
              return (
                <label
                  key={f.value}
                  className={`flex items-center gap-2 ${disabled ? "text-muted" : ""}`}
                  title={disabled ? t("Needs 7-Zip, which was not found") : undefined}
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
              <span className="text-muted">{t("Compression")}</span>
              <select
                aria-label={t("Compression")}
                className={field}
                value={p.level}
                onChange={(e) => updatePack({ level: Number(e.target.value) })}
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {t(l.label)}
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
          {t("Delete the originals after packing (move into the archive)")}
        </label>
        {p.error && (
          <p role="alert" className="text-danger">
            {p.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closePack}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("Pack")}
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
      ? t("Checking the size…")
      : t("{count, plural, one {# file} other {# files}}, {size}", {
          count: u.files,
          size: formatBytes(u.bytes),
        })
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeUnpack()
      }}
      title={t("Unpack {what}", { what: u.what })}
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
          {t("Unpack each archive into its own folder")}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={u.links}
            onChange={(e) => updateUnpack({ links: e.target.checked })}
          />
          {t("Create links stored in the archives (only those that stay inside the folder)")}
        </label>
        <ArchiveWarnings warnings={u.warnings} />
        {u.error && (
          <p role="alert" className="text-danger">
            {u.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeUnpack}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy} autoFocus>
            {u.warnings.length > 0 ? t("Unpack anyway") : t("Unpack")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}
