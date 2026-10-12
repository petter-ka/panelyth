import { Button, DialogWindow, fieldClass as field } from "@panelyth/ui"
import { useState } from "react"
import {
  ALGORITHMS,
  closeHash,
  extOf,
  startHashCreate,
  updateHash,
  useCompareStore,
  type HashDialogState,
} from "../features/compare"
import type { HashAlgorithm } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"

/**
 * Create checksums (Stage C08, CFR-21): SHA-256, SHA-1, MD5 or CRC32, as one
 * checksum file beside each file or as one list in the panel's folder.
 */
export function ChecksumDialog() {
  const h = useCompareStore((s) => s.hash)
  if (!h) return null
  return <ChecksumForm key={`${h.side}-${h.source.queryId}-${h.source.version}`} h={h} />
}

function ChecksumForm({ h }: { h: HashDialogState }) {
  const [busy, setBusy] = useState(false)
  const ext = extOf(h.algorithm)
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeHash()
      }}
      title={t("Create checksums for {what}", { what: h.what })}
      contentClassName="w-[min(32rem,calc(100vw-2rem))]"
    >
      <form
        className="flex flex-col gap-3 text-xs"
        data-testid="checksum-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void startHashCreate().finally(() => setBusy(false))
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted">{t("Algorithm")}</span>
          <select
            aria-label={t("Algorithm")}
            className={field}
            value={h.algorithm}
            autoFocus
            onChange={(e) => updateHash({ algorithm: e.target.value as HashAlgorithm })}
          >
            {ALGORITHMS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-muted">{t("Checksum files")}</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="checksum-files"
              checked={h.perFile}
              onChange={() => updateHash({ perFile: true })}
            />
            {t("One beside each file ({example})", { example: "name.txt" + ext })}
          </label>
          <label
            className={`flex items-center gap-2 ${h.listAllowed ? "" : "text-muted"}`}
            title={h.listAllowed ? undefined : t("Search results have no folder for a list")}
          >
            <input
              type="radio"
              name="checksum-files"
              checked={!h.perFile}
              disabled={!h.listAllowed}
              onChange={() => updateHash({ perFile: false })}
            />
            {t("One list for all of them")}
          </label>
        </fieldset>
        {!h.perFile && (
          <label className="flex flex-col gap-1">
            <span className="text-muted">{t("List name")}</span>
            <span className="flex items-center gap-2">
              <input
                aria-label={t("List name")}
                className={field}
                value={h.name}
                spellCheck={false}
                onChange={(e) => updateHash({ name: e.target.value })}
              />
              <span className="shrink-0 text-muted">{ext}</span>
            </span>
            <span className="text-2xs break-all text-muted">
              {t("In {folder}; an existing list of that name is replaced.", { folder: h.folder })}
            </span>
          </label>
        )}
        {h.error && (
          <p role="alert" className="text-danger">
            {h.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeHash}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("Create")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}
