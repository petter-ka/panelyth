import type { ContentItem, Properties } from "@panelyth/contracts"
import { ImageViewer, requestFit, requestMedia, VideoPlayer } from "@panelyth/media-ui"
import { Tooltip } from "@panelyth/ui"
import { useEffect, useState } from "react"
import { bridge } from "../bridge"
import { formatBytes, formatDate } from "../features/format"
import { QUICK_LANE } from "../features/media"
import { useSettingsStore } from "../features/settings"
import { closeQuickView, useViewersStore } from "../features/viewers"
import { HexView, TextView } from "./ByteViews"
import { useByteFile } from "./useByteFile"

/** Asks for the viewer-fit preview and the original's URL (shared request logic). */
export function useImageRequests(entryId: number, lane: string): void {
  useEffect(() => {
    void requestMedia(entryId)
    void requestFit([{ id: entryId, priority: 0 }], [], lane).catch(() => undefined)
  }, [entryId, lane])
}

function QuickImage({ item }: { item: ContentItem }) {
  useImageRequests(item.id, QUICK_LANE)
  return <ImageViewer key={item.id} entryId={item.id} placeholder={null} lane={QUICK_LANE} />
}

function QuickVideo({ item }: { item: ContentItem }) {
  useImageRequests(item.id, QUICK_LANE)
  return (
    <VideoPlayer
      key={item.id}
      entryId={item.id}
      name={item.name}
      placeholder={null}
      playToken={null}
      lane={QUICK_LANE}
    />
  )
}

function useProperties(entryId: number): Properties | null {
  const [props, setProps] = useState<Properties | null>(null)
  useEffect(() => {
    let live = true
    bridge
      .properties(entryId)
      .then((p) => live && setProps(p))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [entryId])
  return props
}

/** Size, dates and the location: shown for folders and beside the hex of binary files. */
function PropertiesBlock({ item }: { item: ContentItem }) {
  const props = useProperties(item.id)
  const dateFormat = useSettingsStore((s) => s.settings.dateFormat)
  const rows: [string, string][] = [
    ["Name", item.name],
    ["Location", props?.path ?? ""],
  ]
  if (item.kind === "dir") {
    if (props?.childFolders != null) rows.push(["Folders", props.childFolders.toLocaleString()])
    if (item.dirSizeBytes !== undefined) rows.push(["Size", formatBytes(item.dirSizeBytes)])
  } else {
    rows.push(["Size", `${formatBytes(item.sizeBytes)} (${item.sizeBytes.toLocaleString()} bytes)`])
  }
  rows.push(["Modified", formatDate(props?.modifiedMs ?? item.modifiedMs, dateFormat)])
  if (props?.createdMs != null) rows.push(["Created", formatDate(props.createdMs, dateFormat)])
  return (
    <dl
      className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border bg-chrome p-3 text-xs"
      data-testid="quick-properties"
    >
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <Tooltip content={v}>
            <dd className={`truncate text-text ${k === "Name" ? "" : "font-mono"}`}>{v}</dd>
          </Tooltip>
        </div>
      ))}
    </dl>
  )
}

/** Text from the first window on (encoding detected), or hex plus properties for binary files. */
function QuickFile({ item }: { item: ContentItem }) {
  const file = useByteFile(item.id)
  if (file.status === "loading") return <Message text="Reading…" />
  if (file.status === "failed") return <Message text={`This file can't be read: ${file.message}`} />
  const { source, detection } = file
  if (detection.binary) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PropertiesBlock item={item} />
        <HexView key={source.url} source={source} match={null} label={`Hex of ${item.name}`} />
      </div>
    )
  }
  return (
    <TextView
      key={source.url}
      source={source}
      encoding={detection.encoding}
      floor={detection.bom}
      wrap={false}
      match={null}
      label={`Text of ${item.name}`}
    />
  )
}

function Message({ text }: { text: string }) {
  return <p className="p-4 text-center text-xs text-muted">{text}</p>
}

/**
 * Quick view (Ctrl+Q, Stage C05): in place of the other panel, the active
 * panel's cursor entry once the cursor settles: images and videos with the
 * shared components, text, or hex plus properties.
 */
export function QuickView() {
  const item = useViewersStore((s) => s.quickItem)
  let body
  if (!item) body = <Message text="No file under the cursor" />
  else if (item.kind === "dir") body = <PropertiesBlock key={item.id} item={item} />
  else if (item.kind === "image") body = <QuickImage key={item.id} item={item} />
  else if (item.kind === "video") body = <QuickVideo key={item.id} item={item} />
  else body = <QuickFile key={item.id} item={item} />
  return (
    <section
      id="quick-view"
      tabIndex={-1}
      aria-label="Quick view"
      data-testid="quick-view"
      data-entry={item?.id ?? ""}
      data-kind={item?.kind ?? ""}
      className="flex h-full min-w-0 flex-col border-t-2 border-transparent bg-canvas outline-none"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-chrome px-2 text-xs">
        <span className="text-muted">Quick view</span>
        <span className="min-w-0 flex-1 truncate text-text">{item?.name ?? ""}</span>
        <Tooltip content="Close quick view (Ctrl+Q)">
          <button
            type="button"
            onClick={closeQuickView}
            className="rounded px-1.5 py-0.5 text-muted hover:bg-raised hover:text-text"
          >
            Close
          </button>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </section>
  )
}
