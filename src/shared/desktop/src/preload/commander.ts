// The commander's sandboxed preload (ADR-0027, ADR-0031): bundled into one
// CommonJS file of its own. It exposes only the commander's methods; main
// rejects anything else from this app view anyway.
import { contextBridge, ipcRenderer } from "electron"
import {
  IPC_EVENT,
  IPC_INVOKE,
  type CommanderApi,
  type CommanderJobParams,
  type EventChannel,
  type EventMessage,
  type RendererMethod,
  type RenamePlan,
  type RpcEnvelope,
  type SavedConnection,
  type SelectionDescriptor,
} from "@panelyth/contracts"

/** Only the descriptor's known fields cross the bridge. */
const copySelection = (s: SelectionDescriptor): SelectionDescriptor => ({
  queryId: s.queryId,
  version: s.version,
  ranges: s.ranges.map(([a, b]) => [a, b] as [number, number]),
  include: [...s.include],
  exclude: [...s.exclude],
})

type SourceJobParams = Extract<CommanderJobParams, { source: unknown }>

const copyConnection = (c: SavedConnection): SavedConnection => ({
  id: c.id,
  name: c.name,
  group: c.group,
  host: c.host,
  port: c.port,
  tls: c.tls,
  user: c.user,
  startPath: c.startPath,
  localPath: c.localPath,
  active: c.active,
  encoding: c.encoding,
  transfers: c.transfers,
  fingerprint: c.fingerprint,
  hasPassword: c.hasPassword,
})

const copyPlan = (p: RenamePlan): RenamePlan => ({
  nameMask: p.nameMask,
  extMask: p.extMask,
  search: p.search,
  replace: p.replace,
  regex: p.regex,
  matchCase: p.matchCase,
  case: p.case,
  start: p.start,
  step: p.step,
  digits: p.digits,
})

/** Only the known fields of each job kind cross the bridge. */
function jobParams(
  p: Exclude<
    SourceJobParams,
    { kind: "hashCreate" | "multiRename" | "setAttributes" | "compareFiles" }
  >,
): CommanderJobParams {
  const source = { selection: copySelection(p.source.selection) }
  switch (p.kind) {
    case "copy":
    case "move":
      return {
        kind: p.kind,
        source,
        destinationDirId: p.destinationDirId,
        conflict: p.conflict,
        ...(p.verify !== undefined && { verify: p.verify }),
        ...(p.now !== undefined && { now: p.now }),
        ...(p.mask !== undefined && { mask: p.mask }),
        ...(p.name !== undefined && { name: p.name }),
      }
    case "extract":
      return {
        kind: p.kind,
        source,
        destinationDirId: p.destinationDirId,
        conflict: p.conflict,
        ...(p.links !== undefined && { links: p.links }),
        ...(p.subfolders !== undefined && { subfolders: p.subfolders }),
      }
    case "pack":
      return {
        kind: p.kind,
        source,
        destinationDirId: p.destinationDirId,
        conflict: p.conflict,
        name: p.name,
        format: p.format,
        level: p.level,
        ...(p.deleteOriginals !== undefined && { deleteOriginals: p.deleteOriginals }),
      }
    // Stage C10.5: between a connection and this computer.
    case "download":
      return {
        kind: p.kind,
        source,
        destinationDirId: p.destinationDirId,
        conflict: p.conflict,
        ...(p.move !== undefined && { move: p.move }),
      }
    case "upload":
      return {
        kind: p.kind,
        source,
        remoteDirId: p.remoteDirId,
        conflict: p.conflict,
        ...(p.move !== undefined && { move: p.move }),
      }
  }
  return { kind: p.kind, source }
}

/** The compare jobs (Stage C08): a sync and a comparison of two files have no selection. */
function startParams(p: CommanderJobParams): CommanderJobParams {
  switch (p.kind) {
    case "sync":
      return {
        kind: p.kind,
        compareId: p.compareId,
        planVersion: p.planVersion,
        ...(p.deletePermanently !== undefined && { deletePermanently: p.deletePermanently }),
      }
    case "compareFiles":
      // Stage C10.5: several files against the other panel's folder.
      if ("source" in p) {
        return {
          kind: p.kind,
          source: { selection: copySelection(p.source.selection) },
          destinationDirId: p.destinationDirId,
        }
      }
      return { kind: p.kind, leftId: p.leftId, rightId: p.rightId }
    // Stage C09: a multi-rename carries its plan; an undo carries nothing.
    case "multiRename":
      return {
        kind: p.kind,
        source: { selection: copySelection(p.source.selection) },
        plan: copyPlan(p.plan),
      }
    case "undoRename":
      return { kind: p.kind }
    case "setAttributes":
      return {
        kind: p.kind,
        source: { selection: copySelection(p.source.selection) },
        ...(p.setAttrs !== undefined && { setAttrs: p.setAttrs }),
        ...(p.clearAttrs !== undefined && { clearAttrs: p.clearAttrs }),
        ...(p.setMode !== undefined && { setMode: p.setMode }),
        ...(p.clearMode !== undefined && { clearMode: p.clearMode }),
        ...(p.modifiedMs !== undefined && { modifiedMs: p.modifiedMs }),
        ...(p.accessedMs !== undefined && { accessedMs: p.accessedMs }),
        ...(p.recursive !== undefined && { recursive: p.recursive }),
      }
    case "hashCreate": {
      const source = { selection: copySelection(p.source.selection) }
      return p.perFile
        ? { kind: p.kind, source, algorithm: p.algorithm, perFile: true }
        : {
            kind: p.kind,
            source,
            algorithm: p.algorithm,
            perFile: false,
            destinationDirId: p.destinationDirId,
            name: p.name,
          }
    }
  }
  return jobParams(p)
}

const invoke = <R>(method: RendererMethod, params?: unknown): Promise<RpcEnvelope<R>> =>
  ipcRenderer.invoke(IPC_INVOKE, method, params) as Promise<RpcEnvelope<R>>

// The channels this app listens to; the others never reach its listeners.
const channels: ReadonlySet<string> = new Set<EventChannel>([
  "sidecar.status",
  "app.visibility",
  "settings.changed",
  "job.progress",
  "job.conflict",
  "query.invalidated",
  "index.progress",
  "volumes.changed",
  "bookmarks.changed",
  "connections.changed",
  // Stage C06: find files.
  "find.progress",
  // Stage C08: directory compares.
  "compare.progress",
  // Stage P06: Settings → About and the native menu's items.
  "update.state",
  "menu.command",
  // Stage C05: quick view and lister images.
  "preview.ready",
  // ADR-0033: a full-screen media window asks this panel for its next item.
  "mediaWindow.step",
])
const subscribers = new Map<EventChannel, Set<(payload: never) => void>>()

ipcRenderer.on(IPC_EVENT, (_event, message: EventMessage) => {
  subscribers.get(message.ch)?.forEach((listener) => {
    try {
      listener(message.p as never)
    } catch (error) {
      console.error("commander event listener failed", error)
    }
  })
})

const api: CommanderApi = {
  app: {
    exit: () => invoke("app.exit", {}),
    switch: (to, edit) => invoke("app.switch", { to, ...(edit !== undefined && { edit }) }),
    about: () => invoke("app.about", {}),
    openTarget: (target) => invoke("app.openTarget", { target }),
  },
  update: {
    get: () => invoke("update.get", {}),
    check: () => invoke("update.check", {}),
    download: () => invoke("update.download", {}),
    install: () => invoke("update.install", {}),
  },
  system: {
    ping: () => invoke("system.ping", {}),
    info: () => invoke("system.info", {}),
  },
  sidecar: {
    getStatus: () => invoke("sidecar.getStatus", {}),
  },
  library: {
    get: () => invoke("library.get", {}),
    setSetting: (key, value) => invoke("library.setSetting", { key, value }),
    addBookmark: (path, label, group) =>
      invoke("library.addBookmark", { path, label, ...(group !== undefined && { group }) }),
    removeBookmark: (id) => invoke("library.removeBookmark", { id }),
    updateBookmark: ({ id, path, label, group }) =>
      invoke("library.updateBookmark", { id, path, label, group }),
    reorderBookmarks: (ids) => invoke("library.reorderBookmarks", { ids: [...ids] }),
  },
  dir: {
    open: ({ path, recursive, lane }) =>
      invoke("dir.open", { path, recursive, ...(lane !== undefined && { lane }) }),
    openEntry: ({ entryId, recursive, lane }) =>
      invoke("dir.openEntry", { entryId, recursive, ...(lane !== undefined && { lane }) }),
    cancelScan: (scanId) => invoke("dir.cancelScan", { scanId }),
    openContaining: (entryId, lane) =>
      invoke("dir.openContaining", { entryId, ...(lane !== undefined && { lane }) }),
  },
  find: {
    // Copied field by field: only known fields cross the bridge.
    start: (s) =>
      invoke("find.start", {
        roots: [...s.roots],
        mask: s.mask,
        depth: s.depth,
        hidden: s.hidden,
        text: s.text,
        caseSensitive: s.caseSensitive,
        wholeWords: s.wholeWords,
        encodings: [...s.encodings],
        skipBinary: s.skipBinary,
        minSize: s.minSize,
        maxSize: s.maxSize,
        modifiedAfter: s.modifiedAfter,
        modifiedBefore: s.modifiedBefore,
        attrsSet: s.attrsSet,
        attrsClear: s.attrsClear,
      }),
    cancel: (findId) => invoke("find.cancel", { findId }),
  },
  archive: {
    open: (entryId) => invoke("archive.open", { entryId }),
    close: (archiveId) => invoke("archive.close", { archiveId }),
    check: (selection, destinationDirId) =>
      invoke("archive.check", { selection: copySelection(selection), destinationDirId }),
    tools: () => invoke("archive.tools", {}),
  },
  // Stage C10.5 (ADR-0037). Copied field by field; a password goes to main
  // and never comes back.
  remote: {
    connections: () => invoke("remote.connections", {}),
    save: (connection, password, forget) =>
      invoke("remote.saveConnection", {
        connection: copyConnection(connection),
        ...(password !== undefined && { password }),
        ...(forget === true && { forget: true }),
      }),
    remove: (connectionId) => invoke("remote.removeConnection", { connectionId }),
    trust: (connectionId, fingerprint) => invoke("remote.trust", { connectionId, fingerprint }),
    connect: (p) =>
      invoke("remote.connect", {
        ...("connectionId" in p
          ? { connectionId: p.connectionId }
          : {
              quick: {
                host: p.quick.host,
                port: p.quick.port,
                tls: p.quick.tls,
                user: p.quick.user,
                active: p.quick.active,
                encoding: p.quick.encoding,
                transfers: p.quick.transfers,
              },
            }),
        attempt: p.attempt,
        ...(p.password !== undefined && { password: p.password }),
        ...(p.accept !== undefined && { accept: p.accept }),
      }),
    cancel: (attempt) => invoke("remote.cancel", { attempt }),
    disconnect: (remoteId) => invoke("remote.disconnect", { remoteId }),
    open: (remoteId, folder, attempt) =>
      invoke("remote.open", {
        ...(typeof folder === "number" ? { remoteId, dirId: folder } : { remoteId, path: folder }),
        ...(attempt !== undefined && { attempt }),
      }),
    mkdir: (remoteDirId, name) => invoke("remote.mkdir", { remoteDirId, name }),
    rename: (entryId, name) => invoke("remote.rename", { entryId, name }),
    secureStore: () => invoke("remote.secureStore", {}),
  },
  compare: {
    // Copied field by field: only known fields cross the bridge.
    dirs: (p) =>
      invoke("compare.dirs", {
        leftDirId: p.leftDirId,
        rightDirId: p.rightDirId,
        toleranceMs: p.toleranceMs,
        dst: p.dst,
        ignoreDates: p.ignoreDates,
        content: p.content,
        asymmetric: p.asymmetric,
      }),
    cancel: (compareId) => invoke("compare.cancel", { compareId }),
    close: (compareId) => invoke("compare.close", { compareId }),
    show: (compareId, show) => invoke("compare.show", { compareId, show: [...show] }),
    setAction: (compareId, selection, action) =>
      invoke("compare.setAction", { compareId, selection: copySelection(selection), action }),
    plan: (compareId) => invoke("compare.plan", { compareId }),
    marks: (p) =>
      invoke("compare.marks", {
        leftQueryId: p.leftQueryId,
        rightQueryId: p.rightQueryId,
        toleranceMs: p.toleranceMs,
        dst: p.dst,
        ignoreDates: p.ignoreDates,
      }),
  },
  diff: {
    open: (leftId, rightId) => invoke("diff.open", { leftId, rightId }),
    page: (diffId, offset, limit) => invoke("diff.page", { diffId, offset, limit }),
    close: (diffId) => invoke("diff.close", { diffId }),
  },
  rename: {
    preview: (selection, plan, offset, limit) =>
      invoke("rename.preview", {
        selection: copySelection(selection),
        plan: copyPlan(plan),
        offset,
        limit,
      }),
    undoInfo: () => invoke("rename.undoInfo", {}),
  },
  query: {
    // Copied field by field: only known fields cross the bridge.
    open: (d) =>
      invoke("query.open", {
        dirId: d.dirId,
        recursive: d.recursive,
        sort: d.sort.map(({ field, direction }) => ({ field, direction })),
        kinds: [...d.kinds],
        search: d.search,
        exts: [...d.exts],
        favorite: d.favorite,
        minRating: d.minRating,
        tags: [...d.tags],
        ...(d.scope !== undefined && { scope: d.scope }),
        ...(d.showHidden !== undefined && { showHidden: d.showHidden }),
        ...(d.nameMask !== undefined && { nameMask: d.nameMask }),
        ...(d.findId !== undefined && { findId: d.findId }),
        ...(d.archiveId !== undefined && { archiveId: d.archiveId }),
        ...(d.archiveDirId !== undefined && { archiveDirId: d.archiveDirId }),
        ...(d.remoteId !== undefined && { remoteId: d.remoteId }),
        ...(d.remoteDirId !== undefined && { remoteDirId: d.remoteDirId }),
      }),
    page: ({ queryId, offset, limit, thumbProfile }) =>
      invoke("query.page", { queryId, offset, limit, thumbProfile }),
    close: (queryId) => invoke("query.close", { queryId }),
    indexOf: (queryId, entryId) => invoke("query.indexOf", { queryId, entryId }),
    locate: ({ queryId, pattern, from, direction }) =>
      invoke("query.locate", { queryId, pattern, from, direction }),
    match: (queryId, mask) => invoke("query.match", { queryId, mask }),
  },
  selection: {
    info: (selection) => invoke("selection.info", { selection: copySelection(selection) }),
    rebase: (selection) => invoke("selection.rebase", { selection: copySelection(selection) }),
  },
  jobs: {
    dirSize: (selection) =>
      invoke("jobs.start", { kind: "dirSize", source: { selection: copySelection(selection) } }),
    cancel: (jobId) => invoke("jobs.cancel", { jobId }),
  },
  fs: {
    volumes: () => invoke("fs.volumes", {}),
    listDirs: (path, showHidden) => invoke("fs.listDirs", { path, showHidden }),
    mkdir: (parentDirId, path) => invoke("fs.mkdir", { parentDirId, path }),
    canTrash: (dirId) => invoke("fs.canTrash", { dirId }),
    mkfile: (parentDirId, name) => invoke("fs.mkfile", { parentDirId, name }),
  },
  media: {
    open: (entryId) => invoke("media.open", { entryId }),
    openWindow: (entryId, key, theme, lang) =>
      invoke("media.openWindow", {
        entryId,
        key,
        ...(theme && { theme }),
        ...(lang && { lang }),
      }),
    windowAnswer: (requestId, item) => invoke("media.windowAnswer", { requestId, item }),
    windowStep: (direction) => invoke("media.windowStep", { direction }),
    windowReveal: () => invoke("media.windowReveal", {}),
  },
  preview: {
    ensure: ({ lane, epoch, profile, items, force }) =>
      invoke("preview.ensure", {
        lane,
        epoch,
        profile,
        items: items.map(({ id, priority }) => ({ id, priority })),
        force: [...force],
      }),
  },
  props: {
    get: (entryId) => invoke("props.get", { entryId }),
  },
  file: {
    open: (entryId) => invoke("file.open", { entryId }),
  },
  document: {
    open: (entryId, theme, lang) =>
      invoke("document.open", { entryId, ...(theme && { theme }), ...(lang && { lang }) }),
  },
  shell: {
    open: (entryId, allowProgram) =>
      invoke("shell.open", { entryId, ...(allowProgram !== undefined && { allowProgram }) }),
    edit: (entryId) => invoke("shell.edit", { entryId }),
    // Stage C10: only the known fields cross the bridge; never a path.
    run: ({ command, dirId, console }) =>
      invoke("shell.run", { command, dirId, ...(console !== undefined && { console }) }),
    runTool: ({ toolId, dirId, otherDirId, cursorId, selection }) =>
      invoke("shell.runTool", {
        toolId,
        dirId,
        ...(otherDirId !== undefined && { otherDirId }),
        ...(cursorId !== undefined && { cursorId }),
        ...(selection !== undefined && { selection: copySelection(selection) }),
      }),
  },
  files: {
    start: (p) => invoke("jobs.start", startParams(p)),
    pause: (jobId) => invoke("jobs.pause", { jobId }),
    resume: (jobId) => invoke("jobs.resume", { jobId }),
    startNow: (jobId) => invoke("jobs.startNow", { jobId }),
    resolve: (jobId, decision, applyToAll) =>
      invoke("jobs.resolve", { jobId, decision, applyToAll }),
    errors: (jobId, offset, limit) => invoke("jobs.errors", { jobId, offset, limit }),
    list: () => invoke("jobs.list", {}),
    rename: (entryId, name) => invoke("entry.rename", { entryId, name }),
  },
  clip: {
    set: (selection, mode) => invoke("clip.set", { selection: copySelection(selection), mode }),
    get: () => invoke("clip.get", {}),
    paste: (destinationDirId, conflict) => invoke("clip.paste", { destinationDirId, conflict }),
  },
  clipboard: {
    copyPaths: (selection, namesOnly) =>
      invoke("clipboard.copyPaths", {
        selection: copySelection(selection),
        ...(namesOnly !== undefined && { namesOnly }),
      }),
    copyText: (text) => invoke("clipboard.copyText", { text }),
  },
  places: {
    list: () => invoke("places.list", {}),
  },
  context: {
    publish: (dirId, focusId, selection) =>
      invoke("context.publish", {
        app: "commander",
        dirId,
        focusId,
        selection: selection && copySelection(selection),
      }),
    get: () => invoke("context.get", {}),
    selection: (version, queryId) => invoke("selection.fromContext", { version, queryId }),
  },
  onEvent(channel, listener) {
    if (!channels.has(channel)) throw new Error(`unknown event channel: ${String(channel)}`)
    let set = subscribers.get(channel)
    if (!set) subscribers.set(channel, (set = new Set()))
    const fn = listener as (payload: never) => void
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  },
}

contextBridge.exposeInMainWorld("panelyth", api)
