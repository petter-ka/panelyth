import type { SavedConnection } from "@panelyth/contracts"
import { describe, expect, it, vi } from "vitest"
import { electronSecretStore, remoteHandlers, type SecretStore } from "../src/main/remote"
import { RpcError } from "../src/main/sidecar/RpcClient"

// Stage C10.5 (ADR-0037): the two calls in which a password passes through
// main. What the sidecar is given, and what it is never given.

const PASSWORD = "correct horse battery staple"

const connection = (over: Partial<SavedConnection> = {}): SavedConnection => ({
  id: 0,
  name: "Work",
  group: "",
  host: "ftp.example.org",
  port: 21,
  tls: "explicit",
  user: "alice",
  startPath: "/pub",
  localPath: "",
  active: false,
  encoding: "",
  transfers: 2,
  fingerprint: "",
  hasPassword: false,
  ...over,
})

/** A store that "encrypts" by reversing, so ciphertext is recognisably not the password. */
function fakeStore(available = true): SecretStore & { encrypt: ReturnType<typeof vi.fn> } {
  return {
    available: () => available,
    encrypt: vi.fn((text: string) => Buffer.from([...text].reverse().join(""), "utf8")),
    decrypt: (data: Buffer) => [...data.toString("utf8")].reverse().join(""),
  }
}

function setup(store: SecretStore, secret = "") {
  const call = vi.fn(async (method: string, params: unknown) => {
    if (method === "remote.secret") return { secret }
    if (method === "remote.dial") return { remoteId: 3, host: "ftp.example.org" }
    return { ...(params as { connection: SavedConnection }).connection, id: 1, hasPassword: true }
  })
  return { call, handlers: remoteHandlers(call as never, store) }
}

const cipherOf = (text: string): string =>
  Buffer.from([...text].reverse().join(""), "utf8").toString("base64")

describe("saving a connection", () => {
  it("encrypts the password before the sidecar sees anything", async () => {
    const store = fakeStore()
    const { call, handlers } = setup(store)
    const saved = await handlers["remote.saveConnection"](null, {
      connection: connection(),
      password: PASSWORD,
    })
    expect(store.encrypt).toHaveBeenCalledWith(PASSWORD)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith("remote.storeConnection", {
      connection: connection(),
      secret: cipherOf(PASSWORD),
    })
    // Nothing that went to the sidecar, and nothing that came back, holds the password.
    expect(JSON.stringify(call.mock.calls)).not.toContain(PASSWORD)
    expect(JSON.stringify(saved)).not.toContain(PASSWORD)
  })

  it("saves no password where there is no secret store, and says so", async () => {
    const { call, handlers } = setup(fakeStore(false))
    const refused = handlers["remote.saveConnection"](null, {
      connection: connection(),
      password: PASSWORD,
    })
    await expect(refused).rejects.toBeInstanceOf(RpcError)
    await expect(refused).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { reason: "noSecureStore" },
    })
    // Never a clear-text fallback.
    expect(call).not.toHaveBeenCalled()
    expect(handlers["remote.secureStore"]()).toEqual({ available: false })
  })

  it("leaves the stored password alone without a new one, or forgets it when asked", async () => {
    const store = fakeStore()
    const { call, handlers } = setup(store)
    await handlers["remote.saveConnection"](null, { connection: connection({ id: 4 }) })
    expect(call).toHaveBeenLastCalledWith("remote.storeConnection", {
      connection: connection({ id: 4 }),
    })
    await handlers["remote.saveConnection"](null, {
      connection: connection({ id: 4 }),
      forget: true,
    })
    expect(call).toHaveBeenLastCalledWith("remote.storeConnection", {
      connection: connection({ id: 4 }),
      forget: true,
    })
    expect(store.encrypt).not.toHaveBeenCalled()
    // Without a store a connection is still saved: only its password is not.
    const none = setup(fakeStore(false))
    await none.handlers["remote.saveConnection"](null, { connection: connection() })
    expect(none.call).toHaveBeenCalledTimes(1)
  })

  it("passes on only the fields of a connection", async () => {
    const { call, handlers } = setup(fakeStore())
    const sneaky = { ...connection(), secret: "AAAA", password: "x", extra: 1 } as SavedConnection
    await handlers["remote.saveConnection"](null, { connection: sneaky })
    expect(call).toHaveBeenCalledWith("remote.storeConnection", { connection: connection() })
  })
})

describe("connecting", () => {
  it("decrypts a saved connection's password for the one call that dials", async () => {
    const { call, handlers } = setup(fakeStore(), cipherOf(PASSWORD))
    const result = await handlers["remote.connect"](null, { connectionId: 7, attempt: 1 })
    expect(call.mock.calls.map((c) => c[0])).toEqual(["remote.secret", "remote.dial"])
    expect(call).toHaveBeenLastCalledWith("remote.dial", {
      connectionId: 7,
      password: PASSWORD,
      attempt: 1,
    })
    // The renderer gets the connection, not the password.
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
  })

  it("uses a typed password as it is, and none where none is stored", async () => {
    const typed = setup(fakeStore(), cipherOf("stored"))
    await typed.handlers["remote.connect"](null, {
      connectionId: 7,
      attempt: 2,
      password: "typed",
      accept: "ab".repeat(32),
    })
    // The stored one is not even asked for.
    expect(typed.call.mock.calls.map((c) => c[0])).toEqual(["remote.dial"])
    expect(typed.call).toHaveBeenCalledWith("remote.dial", {
      connectionId: 7,
      password: "typed",
      attempt: 2,
      accept: "ab".repeat(32),
    })
    const anonymous = setup(fakeStore(), "")
    await anonymous.handlers["remote.connect"](null, { connectionId: 8, attempt: 3 })
    expect(anonymous.call).toHaveBeenLastCalledWith("remote.dial", {
      connectionId: 8,
      password: "",
      attempt: 3,
    })
  })

  it("asks for the password when the stored one cannot be read here", async () => {
    const broken: SecretStore = {
      available: () => true,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => {
        throw new Error("the keyring has another key")
      },
    }
    for (const store of [broken, fakeStore(false)]) {
      const { call, handlers } = setup(store, cipherOf(PASSWORD))
      await expect(
        handlers["remote.connect"](null, { connectionId: 7, attempt: 1 }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED", details: { reason: "needsPassword" } })
      expect(call.mock.calls.map((c) => c[0])).toEqual(["remote.secret"])
    }
  })

  it("dials a typed connection with its known fields only", async () => {
    const { call, handlers } = setup(fakeStore())
    const quick = {
      host: "10.0.0.7",
      port: 2121,
      tls: "none" as const,
      user: "",
      active: true,
      encoding: "windows-1252",
      transfers: 1,
    }
    await handlers["remote.connect"](null, {
      quick: { ...quick, password: "smuggled" } as typeof quick,
      attempt: 5,
      password: "typed",
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith("remote.dial", { quick, password: "typed", attempt: 5 })
  })
})

describe("the secret store", () => {
  const storage = (available: boolean, backend?: string) => ({
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (data: Buffer) => data.toString(),
    ...(backend !== undefined && { getSelectedStorageBackend: () => backend }),
  })

  it("is there on Windows and macOS when Electron says so", () => {
    expect(electronSecretStore(storage(true), "win32").available()).toBe(true)
    expect(electronSecretStore(storage(true), "darwin").available()).toBe(true)
    expect(electronSecretStore(storage(false), "win32").available()).toBe(false)
  })

  it("does not count the plain-text fallback on Linux as a store", () => {
    expect(electronSecretStore(storage(true, "gnome_libsecret"), "linux").available()).toBe(true)
    expect(electronSecretStore(storage(true, "kwallet6"), "linux").available()).toBe(true)
    expect(electronSecretStore(storage(true, "basic_text"), "linux").available()).toBe(false)
    expect(electronSecretStore(storage(true, "unknown"), "linux").available()).toBe(false)
    expect(electronSecretStore(storage(true), "linux").available()).toBe(false)
  })
})
