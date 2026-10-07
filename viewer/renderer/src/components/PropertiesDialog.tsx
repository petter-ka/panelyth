import type { Properties, SelectionInfo } from "@fastview/contracts"
import { useEffect, useState, type ReactNode } from "react"
import { bridge } from "../bridge"
import { describeError } from "../features/folder/folderStore"
import { labelColor, labelName } from "../features/labels/labels"
import {
  closeProperties,
  usePropertiesStore,
  type PropertiesTarget,
} from "../features/properties/propertiesStore"
import { formatBytes, formatCount, formatDate, plural } from "../lib/format"
import { DialogWindow } from "./ui/dialog"

const KIND = { dir: "Folder", image: "Image", video: "Video", file: "File", link: "Link" } as const

type Loaded =
  | { kind: "entry"; props: Properties }
  | { kind: "selection"; info: SelectionInfo }
  | { kind: "error"; message: string }

function Row({
  label,
  children,
  mono = false,
}: {
  label: string
  children: ReactNode
  mono?: boolean
}) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`min-w-0 break-words select-text ${mono ? "font-mono" : ""}`}>{children}</dd>
    </>
  )
}

function EntryRows({ p }: { p: Properties }) {
  const date = (ms: number | null) => (ms === null ? "Not available" : formatDate(ms))
  return (
    <>
      <Row label="Type">
        {p.kind === "dir" ? (
          "Folder"
        ) : (
          <>
            {KIND[p.kind]} (<span className="font-mono">{p.ext.toUpperCase()}</span>)
          </>
        )}
      </Row>
      <Row label="Location" mono>
        <span data-testid="props-path">{p.path}</span>
      </Row>
      {p.kind !== "dir" && (
        <Row label="Size" mono>
          {formatBytes(p.sizeBytes)} ({formatCount(p.sizeBytes)} bytes)
        </Row>
      )}
      {p.width !== null && p.height !== null && (
        <Row label="Dimensions" mono>
          {formatCount(p.width)} × {formatCount(p.height)}
        </Row>
      )}
      {p.kind === "dir" && (
        <Row label="Contains" mono>
          {p.childFolders === null || p.childMedia === null
            ? "Not listed yet"
            : `${plural(p.childFolders, "folder", "folders")}, ${plural(p.childMedia, "image or video", "images and videos")}`}
        </Row>
      )}
      {p.kind !== "dir" && (
        <>
          <Row label="Favorite">{p.favorite ? "Yes" : "No"}</Row>
          <Row label="Rating">{p.rating > 0 ? "★".repeat(p.rating) : "Not rated"}</Row>
          <Row label="Label">
            {p.label > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-full"
                  style={{ background: labelColor(p.label) ?? undefined }}
                />
                {labelName(p.label)}
              </span>
            ) : (
              "None"
            )}
          </Row>
          <Row label="Tags">{p.tags.length > 0 ? p.tags.join(", ") : "None"}</Row>
        </>
      )}
      <Row label="Created" mono>
        {date(p.createdMs)}
      </Row>
      <Row label="Modified" mono>
        {formatDate(p.modifiedMs)}
      </Row>
      <Row label="Accessed" mono>
        {date(p.accessedMs)}
      </Row>
      {!p.exists && <Row label="Status">The file was moved or deleted since it was indexed.</Row>}
    </>
  )
}

function SelectionRows({ info }: { info: SelectionInfo }) {
  const parts = [
    info.folders > 0 && plural(info.folders, "folder", "folders"),
    info.images > 0 && plural(info.images, "image", "images"),
    info.videos > 0 && plural(info.videos, "video", "videos"),
  ].filter(Boolean)
  return (
    <>
      <Row label="Selected" mono>
        {parts.join(", ") || "Nothing"}
      </Row>
      <Row label="Total size" mono>
        {formatBytes(info.bytes)} ({formatCount(info.bytes)} bytes)
      </Row>
      {info.folders > 0 && <Row label="Note">Folder sizes are not included.</Row>}
    </>
  )
}

function load(target: PropertiesTarget): Promise<Loaded> {
  return target.kind === "entry"
    ? bridge.properties(target.id).then((props) => ({ kind: "entry" as const, props }))
    : bridge.selectionInfo(target.selection).then((info) => ({ kind: "selection" as const, info }))
}

/** Properties for one entry (live stat) or a multi-selection (count and size from the index). */
export function PropertiesDialog() {
  const target = usePropertiesStore((s) => s.target)
  const [loaded, setLoaded] = useState<{ for: PropertiesTarget; value: Loaded } | null>(null)

  useEffect(() => {
    if (!target) return
    let live = true
    load(target)
      .catch((error: unknown) => ({ kind: "error" as const, message: describeError(error) }))
      .then((value) => live && setLoaded({ for: target, value }))
    return () => {
      live = false
    }
  }, [target])

  const value = loaded && loaded.for === target ? loaded.value : null
  let title = "Properties"
  if (value?.kind === "entry") title = value.props.name
  else if (target?.kind === "selection") title = `${plural(target.count, "item", "items")} selected`

  return (
    <DialogWindow
      open={target !== null}
      onOpenChange={(open) => !open && closeProperties()}
      title={title}
    >
      <dl
        className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"
        data-testid="properties"
        aria-busy={value === null}
      >
        {value === null && <Row label="">Loading…</Row>}
        {value?.kind === "entry" && <EntryRows p={value.props} />}
        {value?.kind === "selection" && <SelectionRows info={value.info} />}
        {value?.kind === "error" && <Row label="Error">{value.message}</Row>}
      </dl>
    </DialogWindow>
  )
}
