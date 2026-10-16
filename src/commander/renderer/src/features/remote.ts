import {
  MAX_REMOTE_TRANSFERS,
  type RemoteConnectParams,
  type RemoteQuick,
  type RemoteTls,
  type SavedConnection,
} from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable, PanelythError } from "../bridge"
import { notice } from "./files"
import {
  nextRemoteAttempt,
  openPath,
  openRemoteDir,
  remoteClosed,
  remoteMessage,
  useListingStore,
  type RemoteBase,
} from "./listing"
import { otherSide, type Side } from "./panels"
import { tabsDisconnected } from "./tabs"
import { t } from "@panelyth/i18n"

// Connections to FTP and FTPS servers (Stage C10.5, CFR-31, ADR-0037): the
// saved connections, quick connect, and the connect itself with its
// questions (a password, a certificate that can't be verified). A password
// is typed into a field, handed to main for one call, and kept nowhere in
// this app: not in a store, not in a setting, not in a log. Nothing here
// connects unless the user gave the command.

export const DEFAULT_PORT: Record<RemoteTls, number> = { explicit: 21, implicit: 990, none: 21 }

export const blankConnection = (): SavedConnection => ({
  id: 0,
  name: "",
  group: "",
  host: "",
  port: 21,
  tls: "explicit",
  user: "",
  startPath: "",
  localPath: "",
  active: false,
  encoding: "",
  transfers: 2,
  fingerprint: "",
  hasPassword: false,
})

export const blankQuick = (): RemoteQuick => ({
  host: "",
  port: 21,
  tls: "explicit",
  user: "",
  active: false,
  encoding: "",
  transfers: 2,
})

export type RemoteDialog =
  | { kind: "list"; side: Side }
  | { kind: "edit"; side: Side; connection: SavedConnection }
  | { kind: "quick"; side: Side; quick: RemoteQuick; path: string | null }

/** A question the connect waits on. */
export type RemotePrompt =
  | {
      kind: "password"
      label: string
      user: string
      /** The server refused the one that was tried. */
      wrong: boolean
      /** A saved connection on a computer with a secret store: "Save the password" is offered. */
      canSave: boolean
    }
  | {
      kind: "certificate"
      label: string
      fingerprint: string
      subject: string
      /** It is not the certificate that was accepted for this connection before. */
      changed: boolean
      /** A saved connection: "Always trust" is offered. */
      canRemember: boolean
    }

interface RemoteState {
  connections: SavedConnection[]
  loaded: boolean
  /** Whether this computer can keep passwords (null until asked). */
  secureStore: boolean | null
  dialog: RemoteDialog | null
  connecting: { side: Side; attempt: number; label: string } | null
  prompt: RemotePrompt | null
  /** Why the last connect or save failed. */
  error: string | null
}

export const useRemoteStore = create<RemoteState>(() => ({
  connections: [],
  loaded: false,
  secureStore: null,
  dialog: null,
  connecting: null,
  prompt: null,
  error: null,
}))

const set = useRemoteStore.setState
const get = useRemoteStore.getState

const reasonOf = (error: unknown): unknown =>
  error instanceof PanelythError
    ? (error.details as { reason?: unknown } | undefined)?.reason
    : undefined

function failureText(error: unknown): string {
  if (!(error instanceof PanelythError))
    return error instanceof Error ? error.message : String(error)
  const reason = reasonOf(error)
  if (reason === "noSecureStore") {
    return t("This computer has no secure store for passwords, so the password was not saved.")
  }
  if (reason === "needsPassword") {
    return t("The stored password can't be read on this computer. Type it to connect.")
  }
  if (reason === "duplicate") return t("A connection with this name already exists.")
  return remoteMessage(reason, error.message)
}

// The saved connections ----------------------------------------------------------------

const byName = (a: SavedConnection, b: SavedConnection): number =>
  a.group.localeCompare(b.group) || a.name.localeCompare(b.name) || a.id - b.id

/** Reads the saved connections (no secrets) and whether passwords can be kept. Lists nothing remote. */
export async function loadConnections(): Promise<void> {
  if (!isBridgeAvailable()) return
  const [connections, secureStore] = await Promise.all([
    bridge.connections(),
    bridge.secureStore().catch(() => false),
  ])
  set({ connections: [...connections].sort(byName), loaded: true, secureStore })
}

/** Loaded on first use: the dialog, the drive menu, a tab that wants to connect again. */
export function ensureConnections(): Promise<void> {
  return get().loaded ? Promise.resolve() : loadConnections().catch(() => undefined)
}

/** The connections grouped as the dialog and the drive menu show them ("" = no group, first). */
export function groupConnections(
  connections: readonly SavedConnection[],
): [string, SavedConnection[]][] {
  const groups = new Map<string, SavedConnection[]>()
  for (const c of connections) {
    const list = groups.get(c.group)
    if (list) list.push(c)
    else groups.set(c.group, [c])
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
}

/** "alice@example.org", or "example.org" for an anonymous connection. */
export const hostLabel = (c: { host: string; user: string }): string =>
  c.user ? `${c.user}@${c.host}` : c.host

export const connectionLabel = (c: SavedConnection): string => c.name || hostLabel(c)

/**
 * Saves a connection. `password` is the one typed into the form (encrypted
 * by main before anything is stored); undefined keeps the stored one, and
 * `forget` drops it. Returns the saved connection, or null with `error` set.
 */
export async function saveConnection(
  connection: SavedConnection,
  password?: string,
  forget?: boolean,
): Promise<SavedConnection | null> {
  set({ error: null })
  try {
    const saved = await bridge.saveConnection(connection, password, forget)
    await loadConnections().catch(() => undefined)
    return saved
  } catch (error) {
    // Without a secret store the password is never stored; the connection still is.
    if (reasonOf(error) === "noSecureStore" && password !== undefined) {
      const saved = await bridge.saveConnection(connection).catch(() => null)
      await loadConnections().catch(() => undefined)
      set({ error: failureText(error), secureStore: false })
      return saved
    }
    set({ error: failureText(error) })
    return null
  }
}

export async function removeConnection(connectionId: number): Promise<void> {
  set({ error: null })
  try {
    await bridge.removeConnection(connectionId)
    await loadConnections().catch(() => undefined)
  } catch (error) {
    set({ error: failureText(error) })
  }
}

/** Forgets the certificate that was accepted for a connection. */
export async function forgetCertificate(connectionId: number): Promise<void> {
  try {
    await bridge.trustConnection(connectionId, "")
    await loadConnections().catch(() => undefined)
  } catch (error) {
    set({ error: failureText(error) })
  }
}

// Dialogs ----------------------------------------------------------------------------------

/** Ctrl+Shift+N: the saved connections. */
export function openConnections(side: Side): void {
  set({ dialog: { kind: "list", side }, error: null })
  void ensureConnections()
}

/** Ctrl+N: a connection that is typed and not saved. */
export function openQuickConnect(
  side: Side,
  quick: Partial<RemoteQuick> = {},
  path?: string,
): void {
  set({
    dialog: { kind: "quick", side, quick: { ...blankQuick(), ...quick }, path: path ?? null },
    error: null,
  })
  void ensureConnections()
}

export function editConnection(side: Side, connection: SavedConnection): void {
  set({ dialog: { kind: "edit", side, connection }, error: null })
}

export const closeRemoteDialog = (): void => set({ dialog: null, error: null })

// Connecting -------------------------------------------------------------------------------

const cancelled = new Set<number>()
/** The question on screen: answered by the dialog, or with null when it is closed. */
let answerPrompt: ((value: unknown) => void) | null = null

function ask<T>(prompt: RemotePrompt): Promise<T | null> {
  answerPrompt?.(null)
  set({ prompt })
  return new Promise<T | null>((resolve) => {
    answerPrompt = (value) => {
      answerPrompt = null
      set({ prompt: null })
      resolve(value as T | null)
    }
  })
}

export interface PasswordAnswer {
  password: string
  /** Keep it for the saved connection (encrypted by main). */
  save: boolean
}

/** The password dialog's Connect; null is Cancel. */
export const answerPassword = (answer: PasswordAnswer | null): void => answerPrompt?.(answer)

/** The certificate dialog: trust it for this connect, for good, or not at all (null). */
export const answerCertificate = (answer: "once" | "always" | null): void => answerPrompt?.(answer)

/** Cancel on "Connecting…": the connect stops in Go; a connection it still made is closed. */
export function cancelConnect(): void {
  const c = get().connecting
  if (!c) return
  cancelled.add(c.attempt)
  set({ connecting: null })
  void bridge.remoteCancel(c.attempt).catch(() => undefined)
}

interface ConnectTarget {
  /** A saved connection, or a typed one. */
  saved?: SavedConnection
  quick?: RemoteQuick
  /** A password typed for this connect. Lives in this call only. */
  password?: string
  /** The folder to open instead of the connection's start folder (a tab that connects again). */
  path?: string | null
}

/**
 * Connects and shows the connection in a panel. Asks for a password when
 * the server wants one that is not stored, and about a certificate that
 * can't be verified; a connection that asked for TLS never goes on without
 * it. Returns true once the panel shows the server.
 */
export async function connect(side: Side, target: ConnectTarget): Promise<boolean> {
  const saved = target.saved
  const quick = target.quick
  if ((!saved && !quick) || get().connecting) return false
  const label = saved ? connectionLabel(saved) : hostLabel(quick!)
  let password = target.password
  let savePassword = false
  let accept: string | undefined
  let remember = false
  set({ error: null })
  for (;;) {
    const attempt = nextRemoteAttempt()
    set({ connecting: { side, attempt, label } })
    const params: RemoteConnectParams = {
      ...(saved ? { connectionId: saved.id } : { quick: quick! }),
      attempt,
      ...(password !== undefined && { password }),
      ...(accept !== undefined && { accept }),
    }
    try {
      const result = await bridge.remoteConnect(params)
      if (cancelled.delete(attempt)) {
        void bridge.remoteDisconnect(result.remoteId).catch(() => undefined)
        return false
      }
      set({ connecting: null })
      // What the user chose to keep, now that it is known to work.
      if (saved && remember && accept) {
        void bridge.trustConnection(saved.id, accept).then(loadConnections, () => undefined)
      }
      if (saved && savePassword && password !== undefined) {
        void bridge.saveConnection(saved, password).then(loadConnections, (error: unknown) => {
          notice(failureText(error))
        })
      }
      password = undefined
      const base: RemoteBase = {
        remoteId: result.remoteId,
        connectionId: saved ? saved.id : null,
        label,
        host: result.host,
        port: result.port,
        user: result.user,
        encrypted: result.encrypted,
      }
      set({ dialog: null })
      await openRemoteDir(side, base, target.path || result.startPath || "/")
      // A saved connection may name a folder of this computer for the other panel.
      if (!target.path && result.localPath) void openPath(otherSide(side), result.localPath)
      return useListingStore.getState()[side].remote?.remoteId === result.remoteId
    } catch (error) {
      if (cancelled.delete(attempt)) return false
      set({ connecting: null })
      const reason = reasonOf(error)
      if (reason === "certificate") {
        const d = (error as PanelythError).details as {
          fingerprint?: unknown
          subject?: unknown
          changed?: unknown
        }
        const fingerprint = typeof d.fingerprint === "string" ? d.fingerprint : ""
        if (fingerprint !== "") {
          const answer = await ask<"once" | "always">({
            kind: "certificate",
            label,
            fingerprint,
            subject: typeof d.subject === "string" ? d.subject : "",
            changed: d.changed === true,
            canRemember: saved !== undefined,
          })
          if (!answer) return false
          accept = fingerprint
          remember = answer === "always"
          continue
        }
      }
      if (reason === "auth" || reason === "needsPassword") {
        const answer = await ask<PasswordAnswer>({
          kind: "password",
          label,
          user: saved ? saved.user : quick!.user,
          wrong: reason === "auth" && password !== undefined,
          canSave: saved !== undefined && get().secureStore === true,
        })
        if (!answer) return false
        password = answer.password
        savePassword = answer.save
        continue
      }
      const message = failureText(error)
      set({ error: message })
      // No dialog to show it in (Connect on a tab that is not connected).
      if (!get().dialog) notice(message)
      return false
    }
  }
}

/** "Connect" on a panel that says "Not connected": the saved connection again, or the form filled in. */
export async function reconnect(side: Side): Promise<void> {
  const d = useListingStore.getState()[side].disconnected
  if (!d) return
  await ensureConnections()
  const saved =
    d.connectionId === null ? undefined : get().connections.find((c) => c.id === d.connectionId)
  if (saved) {
    await connect(side, { saved, path: d.path })
    return
  }
  openQuickConnect(
    side,
    { host: d.host, port: d.port, user: d.user, tls: d.encrypted ? "explicit" : "none" },
    d.path,
  )
}

/** Ctrl+Shift+F, the drive bar's Disconnect: closes the panel's connection. */
export async function disconnect(side: Side): Promise<void> {
  const remote = useListingStore.getState()[side].remote
  if (!remote) return
  await bridge.remoteDisconnect(remote.remoteId).catch(() => undefined)
  // Tabs that were on it say "Not connected"; panels showing it go back to their folder.
  tabsDisconnected(remote.remoteId)
  remoteClosed(remote.remoteId)
}

/** A quick connection's settings, checked before anything is sent. */
export function quickProblem(q: RemoteQuick): string | null {
  if (q.host.trim() === "") return t("Enter the server's name or address.")
  if (!Number.isInteger(q.port) || q.port < 1 || q.port > 65535) {
    return t("The port is a number from 1 to 65535.")
  }
  if (!Number.isInteger(q.transfers) || q.transfers < 1 || q.transfers > MAX_REMOTE_TRANSFERS) {
    return t("Transfers at once: 1 to {max}.", { max: MAX_REMOTE_TRANSFERS })
  }
  return null
}

/** Follows changes to the saved connections once they were loaded; returns the stop function. */
export function startRemote(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  return bridge.on("connections.changed", ({ connections }) => {
    if (get().loaded) set({ connections: [...connections].sort(byName) })
  })
}

/** Tests. */
export function resetRemote(): void {
  answerPrompt?.(null)
  answerPrompt = null
  cancelled.clear()
  set({
    connections: [],
    loaded: false,
    secureStore: null,
    dialog: null,
    connecting: null,
    prompt: null,
    error: null,
  })
}
