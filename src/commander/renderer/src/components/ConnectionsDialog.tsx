import {
  MAX_CONNECTION_NAME_CHARS,
  MAX_REMOTE_HOST_CHARS,
  MAX_REMOTE_TRANSFERS,
  type RemoteQuick,
  type RemoteTls,
  type SavedConnection,
} from "@panelyth/contracts"
import { Button, DialogWindow, Spinner } from "@panelyth/ui"
import { useState, type KeyboardEvent, type ReactNode } from "react"
import type { Side } from "../features/panels"
import {
  answerCertificate,
  answerPassword,
  blankConnection,
  cancelConnect,
  closeRemoteDialog,
  connect,
  DEFAULT_PORT,
  editConnection,
  forgetCertificate,
  groupConnections,
  hostLabel,
  openConnections,
  openQuickConnect,
  quickProblem,
  removeConnection,
  saveConnection,
  useRemoteStore,
  type RemotePrompt,
} from "../features/remote"
import { msg, t } from "@panelyth/i18n"

const field =
  "h-8 w-full rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent"

const TLS_LABELS: Record<RemoteTls, string> = {
  explicit: msg("FTPS, explicit TLS (recommended)"),
  implicit: msg("FTPS, implicit TLS"),
  none: msg("FTP, not encrypted"),
}

/** A fingerprint as people compare it: pairs of digits. */
export const fingerprintText = (hex: string): string =>
  (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(":")

function Labeled({
  label,
  children,
  wide,
}: {
  label: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? "col-span-2" : ""}`}>
      <span className="text-muted">{label}</span>
      {children}
    </label>
  )
}

const NotEncrypted = () => (
  <p role="note" className="col-span-2 text-danger">
    {t("Not encrypted: the password and the files can be read on the way.")}
  </p>
)

/**
 * Connections (Stage C10.5, CFR-31, ADR-0037): the saved connections
 * (Ctrl+F), a connection's settings, quick connect (Ctrl+N), and the
 * questions a connect asks. A password is typed here, goes to main with the
 * one call that needs it, and is never read back.
 */
export function RemoteDialogs() {
  const dialog = useRemoteStore((s) => s.dialog)
  const connecting = useRemoteStore((s) => s.connecting)
  const prompt = useRemoteStore((s) => s.prompt)
  return (
    <>
      {dialog?.kind === "list" && <ConnectionList side={dialog.side} />}
      {dialog?.kind === "edit" && (
        <ConnectionForm
          key={dialog.connection.id}
          side={dialog.side}
          connection={dialog.connection}
        />
      )}
      {dialog?.kind === "quick" && (
        <QuickForm side={dialog.side} initial={dialog.quick} path={dialog.path} />
      )}
      {connecting && (
        <DialogWindow
          open
          onOpenChange={(open) => {
            if (!open) cancelConnect()
          }}
          title={t("Connecting to {name}…", { name: connecting.label })}
        >
          <div data-testid="connecting" className="flex items-center gap-3 text-xs">
            <Spinner size={14} />
            <span className="min-w-0 flex-1 truncate text-muted">{connecting.label}</span>
            <Button onClick={cancelConnect} autoFocus>
              {t("Cancel")}
            </Button>
          </div>
        </DialogWindow>
      )}
      {prompt?.kind === "password" && <PasswordPrompt prompt={prompt} />}
      {prompt?.kind === "certificate" && <CertificatePrompt prompt={prompt} />}
    </>
  )
}

function ErrorLine() {
  const error = useRemoteStore((s) => s.error)
  if (!error) return null
  return (
    <p role="alert" className="text-danger">
      {error}
    </p>
  )
}

function ConnectionList({ side }: { side: Side }) {
  const connections = useRemoteStore((s) => s.connections)
  const loaded = useRemoteStore((s) => s.loaded)
  const busy = useRemoteStore((s) => s.connecting !== null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const selected = connections.find((c) => c.id === selectedId) ?? connections[0] ?? null
  const move = (step: number): void => {
    if (connections.length === 0) return
    const at = selected ? connections.indexOf(selected) : -1
    const next = connections[Math.max(0, Math.min(connections.length - 1, at + step))]
    if (next) setSelectedId(next.id)
    setRemoving(null)
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown") move(1)
    else if (e.key === "ArrowUp") move(-1)
    else if (e.key === "Home") move(-connections.length)
    else if (e.key === "End") move(connections.length)
    else if (e.key === "Enter" && selected) void connect(side, { saved: selected })
    else if (e.key === "F4" && selected) editConnection(side, selected)
    else if (e.key === "Delete" && selected) setRemoving(selected.id)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeRemoteDialog()
      }}
      title={t("Connections")}
      contentClassName="w-[min(36rem,calc(100vw-2rem))]"
    >
      <div data-testid="connections-dialog" className="flex flex-col gap-3 text-xs">
        <div
          role="listbox"
          aria-label={t("Saved connections")}
          tabIndex={0}
          autoFocus
          onKeyDown={onKeyDown}
          className="h-56 overflow-y-auto rounded-md border border-border bg-canvas py-1 outline-none focus:border-accent"
        >
          {connections.length === 0 && (
            <p className="px-3 py-2 text-muted">
              {loaded
                ? t("No connections saved yet. Add one with New, or use Quick connect.")
                : t("Loading…")}
            </p>
          )}
          {groupConnections(connections).map(([group, list]) => (
            <div key={group} role="group" aria-label={group || t("Connections")}>
              {group !== "" && (
                <p className="px-3 pt-1.5 pb-0.5 text-[0.6875rem] font-medium text-muted">
                  {group}
                </p>
              )}
              {list.map((c) => (
                <div
                  key={c.id}
                  role="option"
                  aria-selected={c.id === selected?.id}
                  data-testid={`connection-${c.id}`}
                  onClick={() => {
                    setSelectedId(c.id)
                    setRemoving(null)
                  }}
                  onDoubleClick={() => void connect(side, { saved: c })}
                  className={`flex h-7 cursor-default items-center gap-2 px-3 ${c.id === selected?.id ? "bg-accent/20 text-text" : "text-text hover:bg-raised"}`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                  <span className="min-w-0 shrink truncate font-mono text-muted">
                    {hostLabel(c)}
                    {c.port !== DEFAULT_PORT[c.tls] && `:${c.port}`}
                  </span>
                  {c.tls === "none" && (
                    <span className="shrink-0 rounded border border-danger/50 px-1 text-[0.625rem] text-danger">
                      {t("Not encrypted")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        <ErrorLine />
        {removing !== null && selected?.id === removing ? (
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-muted">
              {t("Remove “{name}” and its stored password?", { name: selected.name })}
            </span>
            <Button onClick={() => setRemoving(null)}>{t("Cancel")}</Button>
            <Button
              variant="danger"
              autoFocus
              onClick={() => {
                setRemoving(null)
                void removeConnection(selected.id)
              }}
            >
              {t("Remove")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button className="mr-auto" onClick={() => openQuickConnect(side)}>
              {t("Quick connect…")}
            </Button>
            <Button onClick={() => editConnection(side, blankConnection())}>{t("New…")}</Button>
            <Button disabled={!selected} onClick={() => selected && editConnection(side, selected)}>
              {t("Edit…")}
            </Button>
            <Button
              disabled={!selected}
              onClick={() =>
                // A copy to change: its password is not copied (it is never read back).
                selected &&
                editConnection(side, {
                  ...selected,
                  id: 0,
                  name: t("Copy of {name}", { name: selected.name }),
                  hasPassword: false,
                })
              }
            >
              {t("Duplicate")}
            </Button>
            <Button disabled={!selected} onClick={() => selected && setRemoving(selected.id)}>
              {t("Remove")}
            </Button>
            <Button
              variant="primary"
              disabled={!selected || busy}
              onClick={() => selected && void connect(side, { saved: selected })}
            >
              {t("Connect")}
            </Button>
          </div>
        )}
      </div>
    </DialogWindow>
  )
}

/** What both forms ask about the server. */
function ServerFields<T extends RemoteQuick>({
  value,
  change,
}: {
  value: T
  change(next: Partial<RemoteQuick>): void
}) {
  return (
    <>
      <Labeled label={t("Server")}>
        <input
          aria-label={t("Server")}
          className={field}
          value={value.host}
          maxLength={MAX_REMOTE_HOST_CHARS}
          spellCheck={false}
          placeholder="ftp.example.org"
          onChange={(e) => change({ host: e.target.value.trim() })}
        />
      </Labeled>
      <Labeled label={t("Port")}>
        <input
          aria-label={t("Port")}
          className={field}
          type="number"
          min={1}
          max={65535}
          value={Number.isFinite(value.port) ? value.port : ""}
          onChange={(e) => change({ port: e.target.valueAsNumber })}
        />
      </Labeled>
      <Labeled label={t("Encryption")} wide>
        <select
          aria-label={t("Encryption")}
          className={field}
          value={value.tls}
          onChange={(e) => {
            const tls = e.target.value as RemoteTls
            // The port follows the encryption while it is still the usual one.
            const usual = value.port === DEFAULT_PORT[value.tls]
            change({ tls, ...(usual && { port: DEFAULT_PORT[tls] }) })
          }}
        >
          {(Object.keys(TLS_LABELS) as RemoteTls[]).map((tls) => (
            <option key={tls} value={tls}>
              {t(TLS_LABELS[tls])}
            </option>
          ))}
        </select>
      </Labeled>
      {value.tls === "none" && <NotEncrypted />}
      <Labeled label={t("User name (empty: anonymous)")}>
        <input
          aria-label={t("User name")}
          className={field}
          value={value.user}
          maxLength={MAX_CONNECTION_NAME_CHARS}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => change({ user: e.target.value })}
        />
      </Labeled>
    </>
  )
}

function PasswordField({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string
  onChange(value: string): void
  placeholder?: string
  autoFocus?: boolean
}) {
  return (
    <input
      aria-label={t("Password")}
      className={field}
      type="password"
      // Never offered to, or filled in by, anything that remembers form fields.
      autoComplete="new-password"
      spellCheck={false}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function Advanced<T extends RemoteQuick>({
  value,
  change,
}: {
  value: T
  change(next: Partial<RemoteQuick>): void
}) {
  return (
    <>
      <Labeled label={t("Encoding of names (empty: UTF-8)")}>
        <input
          aria-label={t("Encoding of names")}
          className={field}
          value={value.encoding}
          spellCheck={false}
          placeholder="windows-1252"
          onChange={(e) => change({ encoding: e.target.value.trim() })}
        />
      </Labeled>
      <Labeled label={t("Transfers at once")}>
        <input
          aria-label={t("Transfers at once")}
          className={field}
          type="number"
          min={1}
          max={MAX_REMOTE_TRANSFERS}
          value={Number.isFinite(value.transfers) ? value.transfers : ""}
          onChange={(e) => change({ transfers: e.target.valueAsNumber })}
        />
      </Labeled>
      <label className="col-span-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={value.active}
          onChange={(e) => change({ active: e.target.checked })}
        />
        {t("Active mode (the server connects back; only where passive mode fails)")}
      </label>
    </>
  )
}

function ConnectionForm({ side, connection }: { side: Side; connection: SavedConnection }) {
  const secureStore = useRemoteStore((s) => s.secureStore)
  // The stored certificate may be forgotten while the form is open.
  const stored = useRemoteStore((s) => s.connections.find((c) => c.id === connection.id))
  const [value, setValue] = useState(connection)
  const [password, setPassword] = useState("")
  const [keep, setKeep] = useState(true)
  const [forget, setForget] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const change = (next: Partial<SavedConnection>): void => {
    setValue((v) => ({ ...v, ...next }))
    setProblem(null)
  }
  const hasPassword = (stored?.hasPassword ?? connection.hasPassword) && !forget
  const fingerprint = stored?.fingerprint ?? connection.fingerprint

  const save = async (thenConnect: boolean): Promise<void> => {
    const name = value.name.trim() || value.host
    const startPath = value.startPath.trim()
    const found =
      quickProblem(value) ??
      (startPath !== "" && !startPath.startsWith("/")
        ? t("The folder on the server starts with “/”.")
        : null)
    if (found) {
      setProblem(found)
      return
    }
    setBusy(true)
    const typed = password !== "" ? password : undefined
    const storing = typed !== undefined && keep && secureStore === true
    const saved = await saveConnection(
      { ...value, name, startPath, localPath: value.localPath.trim(), fingerprint },
      storing ? typed : undefined,
      forget && !storing ? true : undefined,
    )
    setBusy(false)
    if (!saved) return
    setPassword("")
    if (!thenConnect) {
      openConnections(side)
      return
    }
    // A password that was typed but not stored still serves this connect.
    await connect(side, { saved, ...(typed !== undefined && !storing && { password: typed }) })
  }

  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) openConnections(side)
      }}
      title={connection.id === 0 ? t("New connection") : t("Edit connection")}
      contentClassName="w-[min(36rem,calc(100vw-2rem))]"
    >
      <form
        data-testid="connection-form"
        className="grid grid-cols-2 gap-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          void save(false)
        }}
      >
        <Labeled label={t("Name")}>
          <input
            aria-label={t("Name")}
            className={field}
            value={value.name}
            maxLength={MAX_CONNECTION_NAME_CHARS}
            autoFocus
            onChange={(e) => change({ name: e.target.value })}
          />
        </Labeled>
        <Labeled label={t("Group (optional)")}>
          <input
            aria-label={t("Group")}
            className={field}
            value={value.group}
            maxLength={MAX_CONNECTION_NAME_CHARS}
            onChange={(e) => change({ group: e.target.value })}
          />
        </Labeled>
        <ServerFields value={value} change={change} />
        <Labeled label={t("Password")}>
          <PasswordField
            value={password}
            onChange={(v) => {
              setPassword(v)
              setForget(false)
            }}
            placeholder={hasPassword ? t("A password is stored") : ""}
          />
        </Labeled>
        <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {secureStore === false ? (
            <p role="note" className="text-muted">
              {t(
                "This computer has no secure store for passwords. Passwords are not saved; you are asked each time.",
              )}
            </p>
          ) : (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              {t("Save the password (encrypted by this computer's secret store)")}
            </label>
          )}
          {hasPassword && (
            <Button size="sm" onClick={() => setForget(true)}>
              {t("Forget the stored password")}
            </Button>
          )}
        </div>
        <Labeled label={t("Folder on the server (empty: /)")}>
          <input
            aria-label={t("Folder on the server")}
            className={field}
            value={value.startPath}
            spellCheck={false}
            placeholder="/"
            onChange={(e) => change({ startPath: e.target.value })}
          />
        </Labeled>
        <Labeled label={t("Folder on this computer for the other panel")}>
          <input
            aria-label={t("Folder on this computer")}
            className={field}
            value={value.localPath}
            spellCheck={false}
            onChange={(e) => change({ localPath: e.target.value })}
          />
        </Labeled>
        <Advanced value={value} change={change} />
        {fingerprint !== "" && (
          <div className="col-span-2 flex items-center gap-2">
            <span className="min-w-0 flex-1 text-muted">
              {t("Accepted certificate (SHA-256):")}{" "}
              <span className="font-mono break-all text-text">{fingerprintText(fingerprint)}</span>
            </span>
            <Button size="sm" onClick={() => void forgetCertificate(connection.id)}>
              {t("Forget")}
            </Button>
          </div>
        )}
        {problem && (
          <p role="alert" className="col-span-2 text-danger">
            {problem}
          </p>
        )}
        <div className="col-span-2">
          <ErrorLine />
        </div>
        <div className="col-span-2 flex justify-end gap-2">
          <Button onClick={() => openConnections(side)}>{t("Cancel")}</Button>
          <Button disabled={busy} onClick={() => void save(true)}>
            {t("Save and connect")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("Save")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}

function QuickForm({
  side,
  initial,
  path,
}: {
  side: Side
  initial: RemoteQuick
  path: string | null
}) {
  const [value, setValue] = useState(initial)
  const [password, setPassword] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const busy = useRemoteStore((s) => s.connecting !== null)
  const change = (next: Partial<RemoteQuick>): void => {
    setValue((v) => ({ ...v, ...next }))
    setProblem(null)
  }
  const submit = (): void => {
    const found = quickProblem(value)
    if (found) {
      setProblem(found)
      return
    }
    void connect(side, {
      quick: value,
      ...(password !== "" && { password }),
      path,
    })
  }
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeRemoteDialog()
      }}
      title={t("Quick connect")}
      description={t("A connection that is not saved. Nothing is kept once it is closed.")}
      contentClassName="w-[min(34rem,calc(100vw-2rem))]"
    >
      <form
        data-testid="quick-connect"
        className="grid grid-cols-2 gap-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <ServerFields value={value} change={change} />
        <Labeled label={t("Password")}>
          <PasswordField value={password} onChange={setPassword} />
        </Labeled>
        <Advanced value={value} change={change} />
        {problem && (
          <p role="alert" className="col-span-2 text-danger">
            {problem}
          </p>
        )}
        <div className="col-span-2">
          <ErrorLine />
        </div>
        <div className="col-span-2 flex justify-end gap-2">
          <Button className="mr-auto" onClick={() => openConnections(side)}>
            {t("Saved connections…")}
          </Button>
          <Button
            onClick={() => {
              const found = quickProblem(value)
              if (found) setProblem(found)
              // The form of a new connection with these settings; the password is typed again there.
              else editConnection(side, { ...blankConnection(), ...value })
            }}
          >
            {t("Save this connection…")}
          </Button>
          <Button onClick={closeRemoteDialog}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("Connect")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}

function PasswordPrompt({ prompt }: { prompt: Extract<RemotePrompt, { kind: "password" }> }) {
  const [password, setPassword] = useState("")
  const [save, setSave] = useState(false)
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) answerPassword(null)
      }}
      title={t("Password for {name}", { name: prompt.label })}
    >
      <form
        data-testid="password-prompt"
        className="flex flex-col gap-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          answerPassword({ password, save: save && prompt.canSave })
        }}
      >
        {prompt.wrong && (
          <p role="alert" className="text-danger">
            {t("The server refused the user name or the password.")}
          </p>
        )}
        <Labeled
          label={
            prompt.user ? t("Password of {user}", { user: prompt.user }) : t("Password (anonymous)")
          }
        >
          <PasswordField value={password} onChange={setPassword} autoFocus />
        </Labeled>
        {prompt.canSave && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            {t("Save the password (encrypted by this computer's secret store)")}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => answerPassword(null)}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary">
            {t("Connect")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}

function CertificatePrompt({ prompt }: { prompt: Extract<RemotePrompt, { kind: "certificate" }> }) {
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) answerCertificate(null)
      }}
      title={
        prompt.changed
          ? t("The certificate of {name} has changed", { name: prompt.label })
          : t("The certificate of {name} can't be verified", { name: prompt.label })
      }
      contentClassName="w-[min(34rem,calc(100vw-2rem))]"
    >
      <div data-testid="certificate-prompt" className="flex flex-col gap-3 text-xs">
        <p className={prompt.changed ? "text-danger" : "text-muted"}>
          {prompt.changed
            ? t(
                "This is not the certificate you accepted for this connection. Someone may be listening in, or the server got a new certificate. Go on only if you know why it changed.",
              )
            : t(
                "No authority this computer trusts signed it, or it is for another name. Compare the fingerprint with one you got from the server's owner before you trust it.",
              )}
        </p>
        {prompt.subject !== "" && (
          <p>
            <span className="text-muted">{t("Issued to:")}</span>{" "}
            <span className="break-all">{prompt.subject}</span>
          </p>
        )}
        <p>
          <span className="text-muted">{t("Fingerprint (SHA-256):")}</span>{" "}
          <span data-testid="fingerprint" className="font-mono break-all">
            {fingerprintText(prompt.fingerprint)}
          </span>
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button autoFocus onClick={() => answerCertificate(null)}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => answerCertificate("once")}>{t("Trust this time")}</Button>
          {prompt.canRemember && (
            <Button variant="danger" onClick={() => answerCertificate("always")}>
              {t("Always trust this certificate")}
            </Button>
          )}
        </div>
      </div>
    </DialogWindow>
  )
}
