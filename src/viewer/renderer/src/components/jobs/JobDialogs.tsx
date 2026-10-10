import type { JobItemError, SelectionDescriptor, Tag } from "@panelyth/contracts"
import { MAX_TAG_CHARS } from "@panelyth/contracts"
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { bridge } from "../../bridge"
import {
  batchRename,
  closeJobDialog,
  confirmDropTransfer,
  confirmPasteReplacing,
  deletePermanently,
  renameOne,
  tagSelection,
  useJobsStore,
  type Sample,
} from "../../features/jobs/jobsStore"
import { applyPattern, parsePattern, splitExt } from "../../features/jobs/pattern"
import { formatCount, plural } from "../../lib/format"
import { buttonClass } from "../ui/button"
import { DialogWindow } from "../ui/dialog"

const input =
  "h-8 w-full rounded-md border border-border bg-raised px-2 text-xs focus:border-accent focus:outline-none"
const primary = buttonClass("primary")
const secondary = buttonClass("secondary")
const danger = buttonClass("danger")

function Buttons({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex justify-end gap-2">{children}</div>
}

function Cancel() {
  return (
    <button type="button" className={secondary} onClick={closeJobDialog}>
      Cancel
    </button>
  )
}

/** F2 on one item: the stem is preselected, as in Explorer and Finder. */
function RenameDialog({ id, name, isDir }: { id: number; name: string; isDir: boolean }) {
  const [value, setValue] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(0, splitExt(name, isDir)[0].length)
  }, [name, isDir])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next = value.trim()
    if (next === name || next === "") return closeJobDialog()
    setBusy(true)
    const problem = await renameOne(id, next)
    setBusy(false)
    if (problem) setError(problem)
    else closeJobDialog()
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted">New name</span>
        <input
          ref={ref}
          className={input}
          value={value}
          aria-invalid={error !== null}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          data-testid="rename-input"
        />
      </label>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      <Buttons>
        <Cancel />
        <button type="submit" className={primary} disabled={busy}>
          Rename
        </button>
      </Buttons>
    </form>
  )
}

/** Pattern rename for a multi-selection, with a preview of the first names. */
function BatchRenameDialog(props: {
  selection: SelectionDescriptor
  count: number
  samples: Sample[]
}) {
  const [pattern, setPattern] = useState("{name} {n:000}")
  const [first, setFirst] = useState(1)
  const parts = parsePattern(pattern)
  const valid = parts !== null && Number.isSafeInteger(first) && first >= 0

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void batchRename(props.selection, props.count, pattern, first)
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-muted">Pattern</span>
          <input
            autoFocus
            className={input}
            value={pattern}
            aria-invalid={!parts}
            onChange={(e) => setPattern(e.target.value)}
            data-testid="pattern-input"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Start at</span>
          <input
            type="number"
            min={0}
            className={input}
            value={first}
            onChange={(e) => setFirst(Number(e.target.value))}
          />
        </label>
      </div>
      <p className="mt-2 text-[0.6875rem] text-muted">
        {"{name}"} is the current name, {"{n}"} a number, {"{n:000}"} a number with three digits.
        Extensions stay the same.
      </p>
      <ol className="mt-3 space-y-1 text-xs" aria-label="Preview" data-testid="rename-preview">
        {props.samples.map((s, i) => (
          <li key={i} className="flex min-w-0 gap-2">
            <span className="min-w-0 flex-1 truncate text-muted">{s.name}</span>
            <span aria-hidden="true">→</span>
            <span className="min-w-0 flex-1 truncate">
              {parts ? applyPattern(parts, s.name, s.isDir, first + i) : "—"}
            </span>
          </li>
        ))}
        {props.count > props.samples.length && (
          <li className="text-muted">and {formatCount(props.count - props.samples.length)} more</li>
        )}
      </ol>
      {!parts && (
        <p role="alert" className="mt-2 text-xs text-danger">
          Use {"{name}"} or {"{n}"} in the pattern.
        </p>
      )}
      <Buttons>
        <Cancel />
        <button type="submit" className={primary} disabled={!valid}>
          Rename {formatCount(props.count)}
        </button>
      </Buttons>
    </form>
  )
}

function DeleteDialog({ selection, count }: { selection: SelectionDescriptor; count: number }) {
  return (
    <div className="text-xs">
      <p>
        {plural(count, "item", "items")} will be deleted permanently. This can't be undone, and
        folders are deleted with everything in them.
      </p>
      <Buttons>
        <Cancel />
        <button
          type="button"
          autoFocus
          className={danger}
          onClick={() => void deletePermanently(selection, count)}
          data-testid="confirm-delete"
        >
          Delete permanently
        </button>
      </Buttons>
    </div>
  )
}

function ReplacePasteDialog(props: {
  destination: string
  folderName: string
  count: number
  mode: "copy" | "cut"
}) {
  return (
    <div className="text-xs">
      <p>
        {plural(props.count, "item", "items")}{" "}
        {props.mode === "cut" ? "will be moved" : "will be copied"} to{" "}
        <span className="font-medium"> {props.folderName}</span>. Items with matching names at the
        destination may be replaced.
      </p>
      <Buttons>
        <Cancel />
        <button
          type="button"
          autoFocus
          className={danger}
          onClick={() =>
            void confirmPasteReplacing(props.destination, props.folderName, props.count, props.mode)
          }
          data-testid="confirm-overwrite"
        >
          Replace existing items
        </button>
      </Buttons>
    </div>
  )
}

function DropTransferDialog(props: {
  selection: SelectionDescriptor
  count: number
  destination: string
  folderName: string
}) {
  return (
    <div className="text-xs">
      <p>
        Copy or cut and paste {plural(props.count, "item", "items")} into{" "}
        <span className="font-medium"> {props.folderName}</span>?
      </p>
      <Buttons>
        <Cancel />
        <button
          type="button"
          autoFocus
          className={secondary}
          onClick={() =>
            void confirmDropTransfer(
              props.selection,
              props.count,
              props.destination,
              props.folderName,
              "copy",
            )
          }
        >
          Copy
        </button>
        <button
          type="button"
          className={primary}
          onClick={() =>
            void confirmDropTransfer(
              props.selection,
              props.count,
              props.destination,
              props.folderName,
              "move",
            )
          }
        >
          Cut and paste
        </button>
      </Buttons>
    </div>
  )
}

/** Adds a tag to (or removes one from) the selected files. */
function TagDialog({ selection, count }: { selection: SelectionDescriptor; count: number }) {
  const [name, setName] = useState("")
  const [tags, setTags] = useState<Tag[] | null>(null)
  useEffect(() => {
    let live = true
    bridge
      .tags()
      .then((t) => live && setTags(t))
      .catch(() => live && setTags([]))
    return () => {
      live = false
    }
  }, [])
  const trimmed = name.trim()
  const fold = trimmed.toLowerCase()
  const matches = (tags ?? []).filter((t) => t.name.toLowerCase().includes(fold)).slice(0, 8)
  const apply = (tag: string, add: boolean) => {
    closeJobDialog()
    void tagSelection(selection, count, tag, add)
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (trimmed) apply(trimmed, true)
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted">
          Tag {plural(count, "file", "files")} (folders are skipped)
        </span>
        <input
          autoFocus
          className={input}
          value={name}
          maxLength={MAX_TAG_CHARS}
          placeholder="New or existing tag"
          onChange={(e) => setName(e.target.value)}
          data-testid="tag-input"
        />
      </label>
      {matches.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs" aria-label="Existing tags">
          {matches.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <span className="text-[0.6875rem] text-muted tabular-nums">
                {formatCount(t.count)}
              </span>
              <button type="button" className={secondary} onClick={() => apply(t.name, true)}>
                Add
              </button>
              <button type="button" className={secondary} onClick={() => apply(t.name, false)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <Buttons>
        <Cancel />
        <button type="submit" className={primary} disabled={!trimmed}>
          Add tag
        </button>
      </Buttons>
    </form>
  )
}

const ERRORS_PAGE = 100

/** The per-item failures of a finished job, paged from Go. */
function ErrorsDialog({ jobId }: { jobId: number }) {
  const [errors, setErrors] = useState<{ list: JobItemError[]; total: number } | null>(null)
  useEffect(() => {
    let live = true
    bridge
      .jobErrors(jobId, 0, ERRORS_PAGE)
      .then((r) => live && setErrors({ list: r.errors, total: r.total }))
      .catch(() => live && setErrors({ list: [], total: 0 }))
    return () => {
      live = false
    }
  }, [jobId])
  return (
    <div className="text-xs">
      {errors === null ? (
        <p className="text-muted">Loading…</p>
      ) : errors.list.length === 0 ? (
        <p className="text-muted">The details are no longer available.</p>
      ) : (
        <ul className="max-h-72 space-y-2 overflow-y-auto" data-testid="job-errors">
          {errors.list.map((e, i) => (
            <li key={i}>
              <div className="truncate font-medium">{e.name || "Unknown item"}</div>
              <div className="text-muted">{e.message}</div>
            </li>
          ))}
        </ul>
      )}
      {errors && errors.total > errors.list.length && (
        <p className="mt-2 text-muted">
          Showing the first {formatCount(errors.list.length)} of {formatCount(errors.total)}.
        </p>
      )}
      <Buttons>
        <button type="button" className={secondary} onClick={closeJobDialog}>
          Close
        </button>
      </Buttons>
    </div>
  )
}

const TITLE = {
  rename: "Rename",
  batchRename: "Rename items",
  replacePaste: "Overwrite existing items?",
  dropTransfer: "Copy or move items?",
  delete: "Delete permanently?",
  tag: "Tags",
  errors: "Items that failed",
} as const

export function JobDialogs() {
  const dialog = useJobsStore((s) => s.dialog)
  return (
    <DialogWindow
      open={dialog !== null}
      onOpenChange={(open) => !open && closeJobDialog()}
      title={dialog ? TITLE[dialog.kind] : ""}
    >
      {dialog?.kind === "rename" && <RenameDialog {...dialog} />}
      {dialog?.kind === "batchRename" && <BatchRenameDialog {...dialog} />}
      {dialog?.kind === "replacePaste" && <ReplacePasteDialog {...dialog} />}
      {dialog?.kind === "dropTransfer" && <DropTransferDialog {...dialog} />}
      {dialog?.kind === "delete" && <DeleteDialog {...dialog} />}
      {dialog?.kind === "tag" && <TagDialog {...dialog} />}
      {dialog?.kind === "errors" && <ErrorsDialog jobId={dialog.jobId} />}
    </DialogWindow>
  )
}
