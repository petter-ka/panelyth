import { Button, DialogWindow } from "@panelyth/ui"
import { useState } from "react"
import {
  closeCopy,
  closeDelete,
  closeMkdir,
  confirmDelete,
  createFolder,
  POLICIES,
  startCopy,
  switchToPermanent,
  updateCopy,
  useFilesStore,
  type CopyDialogState,
} from "../features/files"
import { formatBytes } from "../features/format"
import { ArchiveWarnings } from "./ArchiveDialogs"
import { t } from "@panelyth/i18n"

const field =
  "h-8 w-full rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent"

const amount = (bytes: number | null): string => (bytes === null ? "" : ` (${formatBytes(bytes)})`)

/**
 * F5 / F6 / Shift+F5 (Stage C04, CFR-11): "Copy 12 items (48 MB) to:" with
 * the destination (editable), a file mask, the conflict policy, verify, and
 * Copy (start now) or Queue. Enter copies, Esc cancels.
 */
export function CopyDialog() {
  const c = useFilesStore((s) => s.copy)
  if (!c) return null
  // One form per opening (the source), so typing never remounts it.
  return (
    <CopyForm
      key={`${c.kind}-${c.side}-${c.source.queryId}-${c.source.version}-${String(c.name !== null)}`}
      c={c}
    />
  )
}

function CopyForm({ c }: { c: CopyDialogState }) {
  const [busy, setBusy] = useState(false)
  const move = c.kind === "move"
  const verb = move ? t("Move") : t("Copy")
  // F5 in an archive panel copies entries out (an extract job, Stage C07).
  const extract = c.kind === "extract"
  const here = c.name !== null
  const submit = async (now: boolean): Promise<void> => {
    setBusy(true)
    await startCopy(now)
    setBusy(false)
  }
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeCopy()
      }}
      title={
        here
          ? t("Copy {what} here", { what: c.what })
          : extract
            ? t("Copy {what}{amount} out of the archive", {
                what: c.what,
                amount: amount(c.bytes),
              })
            : move
              ? t("Move {what}{amount}", { what: c.what, amount: amount(c.bytes) })
              : t("Copy {what}{amount}", { what: c.what, amount: amount(c.bytes) })
      }
      contentClassName="w-[min(34rem,calc(100vw-2rem))]"
    >
      <form
        className="flex flex-col gap-3 text-xs"
        data-testid="copy-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(true)
        }}
      >
        {here ? (
          <label className="flex flex-col gap-1">
            <span className="text-muted">{t("New name")}</span>
            <input
              aria-label={t("New name")}
              className={field}
              value={c.name ?? ""}
              spellCheck={false}
              onChange={(e) => updateCopy({ name: e.target.value })}
              onFocus={(e) => {
                // The name without its extension is selected (as in rename).
                const dot = e.target.value.lastIndexOf(".")
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
              }}
              autoFocus
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-muted">{move ? t("Move to") : t("Copy to")}</span>
            <input
              aria-label={t("Destination")}
              className={field}
              value={c.destination}
              spellCheck={false}
              onChange={(e) => updateCopy({ destination: e.target.value })}
              autoFocus
            />
          </label>
        )}
        <div className="flex gap-3">
          {!here && !extract && (
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-muted">{t("Only files matching")}</span>
              <input
                aria-label={t("File mask")}
                className={field}
                value={c.mask}
                spellCheck={false}
                onChange={(e) => updateCopy({ mask: e.target.value })}
              />
            </label>
          )}
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-muted">{t("If the name exists")}</span>
            <select
              aria-label={t("If the name exists")}
              className={field}
              value={c.conflict}
              onChange={(e) =>
                updateCopy({ conflict: e.target.value as CopyDialogState["conflict"] })
              }
            >
              {POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {t(p.label)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {extract ? (
          <>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={c.links}
                onChange={(e) => updateCopy({ links: e.target.checked })}
              />
              {t("Create links stored in the archive (only those that stay inside the folder)")}
            </label>
            <ArchiveWarnings warnings={c.warnings} />
          </>
        ) : (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={c.verify}
              onChange={(e) => updateCopy({ verify: e.target.checked })}
            />
            {t("Verify after copying (compare checksums)")}
          </label>
        )}
        {c.error && (
          <p role="alert" className="text-danger">
            {c.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeCopy}>{t("Cancel")}</Button>
          {!here && !extract && (
            <Button
              disabled={busy}
              onClick={() => void submit(false)}
              title={t("After the other jobs on these drives")}
            >
              {t("Queue")}
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={busy}>
            {verb}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}

/**
 * F8 / Delete and Shift+F8 / Shift+Delete (CFR-12): count and size, trash or
 * permanent in the title; where the trash is unavailable the dialog says so
 * and offers permanent delete.
 */
export function DeleteDialog() {
  const r = useFilesStore((s) => s.remove)
  if (!r) return null
  const noTrash = !r.permanent && r.trash === false
  const title = r.permanent
    ? t("Delete {what} permanently?", { what: r.what })
    : t("Move {what} to the trash?", { what: r.what })
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeDelete()
      }}
      title={title}
      description={
        noTrash
          ? t("This drive has no trash. The items can only be deleted permanently.")
          : r.permanent
            ? t("This can't be undone.")
            : t("You can restore them from the trash.")
      }
    >
      <form
        data-testid="delete-dialog"
        className="flex flex-col gap-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          if (noTrash) switchToPermanent()
          else void confirmDelete()
        }}
      >
        <p className="text-muted">
          {t("{count, plural, one {# item} other {# items}}", { count: r.count })}
          {r.bytes !== null && `, ${formatBytes(r.bytes)}`}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={closeDelete}>{t("Cancel")}</Button>
          {noTrash ? (
            <Button type="submit" variant="danger" autoFocus>
              {t("Delete permanently…")}
            </Button>
          ) : (
            <Button
              type="submit"
              variant={r.permanent ? "danger" : "primary"}
              disabled={!r.permanent && r.trash === null}
              autoFocus
            >
              {r.permanent ? t("Delete permanently") : t("Move to trash")}
            </Button>
          )}
        </div>
      </form>
    </DialogWindow>
  )
}

/** F7 (CFR-12): one field; "a/b/c" creates the chain. */
export function MkdirDialog() {
  const m = useFilesStore((s) => s.mkdir)
  const [name, setName] = useState("")
  if (!m) return null
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) {
          setName("")
          closeMkdir()
        }
      }}
      title={t("New folder")}
      description={t("Use / to create folders inside each other, e.g. 2026/Trip/Raw.")}
    >
      <form
        className="flex flex-col gap-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() === "") return
          void createFolder(name).then((ok) => ok && setName(""))
        }}
      >
        <input
          aria-label={t("Folder name")}
          className={field}
          value={name}
          spellCheck={false}
          aria-invalid={m.error !== null}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        {m.error && (
          <p role="alert" className="text-danger">
            {m.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeMkdir}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={name.trim() === ""}>
            {t("Create")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}
