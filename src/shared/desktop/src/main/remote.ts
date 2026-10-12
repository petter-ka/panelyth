import type {
  RemoteConnectParams,
  RemoteConnectResult,
  RemoteQuick,
  SaveConnectionParams,
  SavedConnection,
  SecureStoreResult,
  SidecarMethod,
} from "@panelyth/contracts"
import { RpcError } from "./sidecar/RpcClient"

// Connections to FTP servers (Stage C10.5, ADR-0037): the two calls in which
// a password passes through main. A password a renderer wants saved is
// encrypted here with the system's secret store before the sidecar stores
// it; a stored one is decrypted here for the length of one connect. No
// call returns a password to a renderer, and none is logged: this module
// writes no log line at all.

/** The system's secret store as main uses it (Electron's safeStorage); tests replace it. */
export interface SecretStore {
  /** Secrets are really protected: the store is there, and it is not a plain-text fallback. */
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

/** The part of Electron's safeStorage this module uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
  /** Linux only. */
  getSelectedStorageBackend?(): string
}

export function electronSecretStore(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): SecretStore {
  return {
    available() {
      if (!safeStorage.isEncryptionAvailable()) return false
      // Without a keyring, Chromium on Linux "encrypts" with a fixed key
      // (basic_text). That protects nothing, so it counts as no store.
      if (platform === "linux") {
        const backend = safeStorage.getSelectedStorageBackend?.() ?? "unknown"
        if (backend === "basic_text" || backend === "unknown") return false
      }
      return true
    },
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  }
}

/** A computer without a secret store: nothing is encrypted, so nothing is saved. */
export const noSecretStore: SecretStore = {
  available: () => false,
  encrypt: () => {
    throw new Error("no secret store")
  },
  decrypt: () => {
    throw new Error("no secret store")
  },
}

type Call = (method: SidecarMethod, params: unknown) => Promise<unknown>

const refused = (reason: "noSecureStore" | "needsPassword", message: string): RpcError =>
  new RpcError("PERMISSION_DENIED", message, false, { reason })

/** Only the known fields of a typed connection cross to the sidecar. */
const copyQuick = (q: RemoteQuick): RemoteQuick => ({
  host: q.host,
  port: q.port,
  tls: q.tls,
  user: q.user,
  active: q.active,
  encoding: q.encoding,
  transfers: q.transfers,
})

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

export function remoteHandlers(call: Call, store: SecretStore) {
  return {
    "remote.secureStore": (): SecureStoreResult => ({ available: store.available() }),

    "remote.saveConnection": async (
      _event: unknown,
      p: SaveConnectionParams,
    ): Promise<SavedConnection> => {
      const connection = copyConnection(p.connection)
      if (p.password === undefined) {
        return (await call("remote.storeConnection", {
          connection,
          ...(p.forget === true && { forget: true }),
        })) as SavedConnection
      }
      // Never a clear-text fallback: without a secret store the password is not saved.
      if (!store.available()) {
        throw refused(
          "noSecureStore",
          "This computer has no secure store for passwords, so the password was not saved.",
        )
      }
      const secret = store.encrypt(p.password).toString("base64")
      return (await call("remote.storeConnection", { connection, secret })) as SavedConnection
    },

    "remote.connect": async (
      _event: unknown,
      p: RemoteConnectParams,
    ): Promise<RemoteConnectResult> => {
      const target =
        "connectionId" in p ? { connectionId: p.connectionId } : { quick: copyQuick(p.quick) }
      let password = p.password ?? ""
      // A saved connection without a typed password: its stored one, decrypted for this call.
      if ("connectionId" in p && p.password === undefined) {
        const { secret } = (await call("remote.secret", { connectionId: p.connectionId })) as {
          secret: string
        }
        if (secret !== "") {
          try {
            if (!store.available()) throw new Error("no store")
            password = store.decrypt(Buffer.from(secret, "base64"))
          } catch {
            // Another user profile, a changed keyring: the stored password is of no use here.
            throw refused(
              "needsPassword",
              "The stored password can't be read on this computer. Type it to connect.",
            )
          }
        }
      }
      return (await call("remote.dial", {
        ...target,
        password,
        attempt: p.attempt,
        ...(p.accept !== undefined && { accept: p.accept }),
      })) as RemoteConnectResult
    },
  }
}
