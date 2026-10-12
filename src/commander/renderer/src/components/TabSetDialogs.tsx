import { Button, DialogWindow, fieldClass as field } from "@panelyth/ui"
import { useState } from "react"
import { notice } from "../features/files"
import type { Side } from "../features/panels"
import { useTabsStore } from "../features/tabs"
import {
  closeTabSetDialog,
  findTabSet,
  lockedTabsReplaced,
  MAX_SET_NAME,
  openTabSet,
  removeTabSet,
  renameTabSet,
  saveTabSet,
  useTabSetsStore,
  type SaveScope,
  type TabSet,
} from "../features/tabsets"
import { t } from "@panelyth/i18n"

const tabCount = (count: number): string =>
  t("{count, plural, one {# tab} other {# tabs}}", { count })

/** "3 tabs", or "Left: 3 tabs · Right: 2 tabs" for a set of both panels. */
function setSummary(s: TabSet): string {
  if (s.panels.length < 2) return tabCount(s.panels[0]!.tabs.length)
  return t("Left: {left} · Right: {right}", {
    left: tabCount(s.panels[0]!.tabs.length),
    right: tabCount(s.panels[1]!.tabs.length),
  })
}

/** The tab bar's "Save tabs…" and "Tab sets…" (Stage C10.5, CFR-08). */
export function TabSetDialogs() {
  const dialog = useTabSetsStore((s) => s.dialog)
  if (!dialog) return null
  return dialog.kind === "save" ? (
    <SaveTabsDialog side={dialog.side} />
  ) : (
    <ManageTabSetsDialog side={dialog.side} />
  )
}

function SaveTabsDialog({ side }: { side: Side }) {
  const here = useTabsStore((s) => s[side].tabs.length)
  const all = useTabsStore((s) => s.left.tabs.length + s.right.tabs.length)
  const [name, setName] = useState("")
  const [scope, setScope] = useState<SaveScope>("panel")
  const [error, setError] = useState<string | null>(null)
  const replaces = name.trim() !== "" && findTabSet(name) !== undefined
  const save = (): void => {
    const result = saveTabSet(name, scope, side)
    if (!result.ok) {
      setError(
        result.reason === "name"
          ? t("Enter a name for the tab set.")
          : result.reason === "full"
            ? t("There is no room for another tab set. Remove one first.")
            : t("A panel has no folder open yet."),
      )
      return
    }
    closeTabSetDialog()
    notice(
      result.leftOut > 0
        ? t(
            "Tab set “{name}” saved; {count, plural, one {# tab} other {# tabs}} without a folder left out.",
            { name: name.trim(), count: result.leftOut },
          )
        : t("Tab set “{name}” saved.", { name: name.trim() }),
    )
  }
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeTabSetDialog()
      }}
      title={t("Save tabs")}
      description={t(
        "A tab set keeps each tab's folder, name, sort, view and lock. Open it again from the tab menu.",
      )}
    >
      <form
        className="flex flex-col gap-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted">{t("Name")}</span>
          <input
            autoFocus
            className={field}
            value={name}
            maxLength={MAX_SET_NAME}
            aria-invalid={error !== null}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-muted">{t("Tabs to save")}</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="tabset-scope"
              checked={scope === "panel"}
              onChange={() => setScope("panel")}
            />
            {side === "left"
              ? t("The left panel's ({tabs})", { tabs: tabCount(here) })
              : t("The right panel's ({tabs})", { tabs: tabCount(here) })}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="tabset-scope"
              checked={scope === "both"}
              onChange={() => setScope("both")}
            />
            {t("Both panels' ({tabs})", { tabs: tabCount(all) })}
          </label>
        </fieldset>
        {replaces && !error && (
          <p role="status" className="text-warning">
            {t("A tab set with this name exists and will be replaced.")}
          </p>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeTabSetDialog}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary">
            {t("Save")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}

function ManageTabSetsDialog({ side }: { side: Side }) {
  const sets = useTabSetsStore((s) => s.sets)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selected = sets.find((s) => s.id === selectedId) ?? sets[0] ?? null
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeTabSetDialog()
      }}
      title={t("Tab sets")}
      description={
        side === "left"
          ? t("A set of one panel opens in the left panel; a set of both panels opens in both.")
          : t("A set of one panel opens in the right panel; a set of both panels opens in both.")
      }
      contentClassName="w-[min(40rem,calc(100vw-2rem))]"
    >
      <div className="flex gap-3 text-xs">
        <ul
          role="listbox"
          aria-label={t("Tab sets")}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
            e.preventDefault()
            const at = sets.findIndex((s) => s.id === selected?.id)
            const next = sets[at + (e.key === "ArrowDown" ? 1 : -1)]
            if (next) setSelectedId(next.id)
          }}
          className="h-64 w-56 shrink-0 overflow-y-auto rounded-md border border-border bg-canvas py-1 outline-none focus-visible:border-accent"
        >
          {sets.map((s) => (
            <li
              key={s.id}
              role="option"
              aria-selected={s.id === selected?.id}
              onClick={() => setSelectedId(s.id)}
              onDoubleClick={() => {
                if (lockedTabsReplaced(s.id, side) > 0) return
                closeTabSetDialog()
                void openTabSet(s.id, side, "replace")
              }}
              className="flex cursor-default flex-col px-2 py-1 aria-selected:bg-accent/20"
            >
              <span className="truncate">{s.name}</span>
              <span className="truncate text-2xs text-muted">{setSummary(s)}</span>
            </li>
          ))}
          {sets.length === 0 && (
            <li className="px-2 py-1 text-muted">
              {t("No tab sets yet. Save the tabs from the tab menu.")}
            </li>
          )}
        </ul>
        {selected && <TabSetForm key={selected.id} set={selected} side={side} />}
      </div>
    </DialogWindow>
  )
}

function TabSetForm({ set, side }: { set: TabSet; side: Side }) {
  const [name, setName] = useState(set.name)
  const [error, setError] = useState<string | null>(null)
  // Opening in place of the tabs closes locked tabs too: asked once, here.
  const [confirm, setConfirm] = useState(false)
  const locked = lockedTabsReplaced(set.id, side)
  const open = (mode: "replace" | "add"): void => {
    if (mode === "replace" && locked > 0 && !confirm) {
      setConfirm(true)
      return
    }
    closeTabSetDialog()
    void openTabSet(set.id, side, mode)
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setError(
            renameTabSet(set.id, name) ? null : t("Another tab set has this name, or it is empty."),
          )
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted">{t("Name")}</span>
          <input
            className={field}
            value={name}
            maxLength={MAX_SET_NAME}
            aria-invalid={error !== null}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={name.trim() === "" || name.trim() === set.name}>
          {t("Rename")}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <ul
        aria-label={t("Folders of the tab set")}
        className="h-32 overflow-y-auto rounded-md border border-border bg-canvas py-1"
      >
        {set.panels.map((panel, p) =>
          panel.tabs.map((tab, i) => (
            <li key={`${p}-${i}`} className="flex items-center gap-2 px-2 py-0.5">
              {set.panels.length === 2 && (
                <span className="w-10 shrink-0 text-2xs text-muted">
                  {p === 0 ? t("Left") : t("Right")}
                </span>
              )}
              <span className="shrink-0 truncate">{tab.title || tab.name}</span>
              <span className="min-w-0 flex-1 truncate text-2xs text-muted">{tab.path}</span>
            </li>
          )),
        )}
      </ul>
      {confirm && (
        <p role="alert" className="text-warning">
          {t(
            "This closes {count, plural, one {# locked tab} other {# locked tabs}}. Choose “Open” again to go on.",
            { count: locked },
          )}
        </p>
      )}
      <div className="mt-auto flex justify-between gap-2">
        <Button variant="danger" onClick={() => removeTabSet(set.id)}>
          {t("Remove")}
        </Button>
        <div className="flex gap-2">
          <Button onClick={() => open("add")}>{t("Add to the tabs")}</Button>
          <Button variant="primary" onClick={() => open("replace")}>
            {t("Open")}
          </Button>
        </div>
      </div>
    </div>
  )
}
