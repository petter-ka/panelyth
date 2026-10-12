// Batch mode of the editor (Stage 16, ADR-0036): what replaces the Save
// controls while the list on screen is a recipe for many pictures. The
// filmstrip shows the recipe on real samples; the Output dialog says where
// the results go and what they are called; Run starts one job in Go. A
// folder is named by a handle of main's dialog, never by a path.
import { useState } from "react"
import {
  BATCH_FORMATS,
  MAX_DPI,
  MAX_JPEG_QUALITY,
  MAX_RECIPE_NAME_CHARS,
  MAX_TEMPLATE_CHARS,
  MIN_JPEG_QUALITY,
  type BatchConflict,
  type BatchDestination,
  type BatchFormat,
  type BatchPlanResult,
  type BatchSkipReason,
  type BatchWarning,
  type MetadataPolicy,
  type StoredRecipe,
} from "@panelyth/contracts"
import { Button, DialogWindow, Spinner, Tooltip } from "@panelyth/ui"
import { msg, t } from "@panelyth/i18n"
import {
  applyRecipe,
  deleteRecipe,
  openBatchDialog,
  pickFolder,
  problemText,
  runBatch,
  runBlocker,
  saveRecipe,
  selectSample,
  setOutput,
  useBatchStore,
} from "../../features/editor/batchStore"
import { useEditorSettings } from "../../features/editor/editorSettings"
import { cancelClose, closeEditorNow, useEditorStore } from "../../features/editor/editorStore"
import { useShortcutHint } from "../../features/shortcuts/shortcutStore"
import { formatBytes, formatCount } from "../../lib/format"
import { NumberField, Select, Slider } from "./controls"

const pictures = (count: number): string =>
  t("{count, plural, one {# picture} other {# pictures}}", { count })

const formatLabel = (f: BatchFormat): string =>
  f === "keep" ? t("Keep each picture's format") : f === "jpeg" ? "JPEG" : f.toUpperCase()

const SKIP_TEXT: Record<BatchSkipReason, string> = {
  folder: msg("{count, plural, one {# folder} other {# folders}}"),
  video: msg("{count, plural, one {# video} other {# videos}}"),
  other: msg(
    "{count, plural, one {# file that is not a picture} other {# files that are not pictures}}",
  ),
  unsupported: msg(
    "{count, plural, one {# picture of a kind that can't be edited} other {# pictures of a kind that can't be edited}}",
  ),
  notWritable: msg(
    "{count, plural, one {# picture whose format can't be written} other {# pictures whose format can't be written}}",
  ),
}

const WARNING_TEXT: Record<BatchWarning, string> = {
  trashUnavailable: msg(
    "A drive here has no trash, so nothing can be replaced safely. Choose another destination or policy.",
  ),
  formatChange: msg("WebP can't be written: those pictures are saved as PNG."),
  alphaLoss: msg("JPEG has no transparency: transparent areas become white."),
}

/** "3 skipped": what was left out and why, for the summary. */
function skippedText(plan: BatchPlanResult): string {
  return plan.skipped.map((s) => t(SKIP_TEXT[s.reason], { count: s.count })).join(", ")
}

function destinationText(destination: BatchDestination, folder: string | undefined): string {
  switch (destination) {
    case "beside":
      return t("next to the originals")
    case "folder":
      return folder ? t("into “{folder}”", { folder }) : t("into a folder you choose")
    case "replace":
      return t("replacing the originals")
  }
}

/** The line that says what Run will do: how many, what is left out, how much, where. */
export function BatchSummary() {
  const plan = useBatchStore((s) => s.plan)
  const destination = useBatchStore((s) => s.output.destination)
  const folder = useBatchStore((s) => s.folder?.name)
  if (!plan) {
    return (
      <p className="text-[0.6875rem] text-muted" data-testid="batch-summary" role="status">
        {t("Counting the pictures…")}
      </p>
    )
  }
  const skipped = plan.skipped.reduce((n, s) => n + s.count, 0)
  return (
    <p
      className="flex min-w-0 items-baseline gap-1.5 text-[0.6875rem] text-muted tabular-nums"
      data-testid="batch-summary"
      role="status"
    >
      <span className="text-text">{pictures(plan.count)}</span>
      {skipped > 0 && (
        <Tooltip content={skippedText(plan)}>
          <span tabIndex={0} className="underline decoration-dotted underline-offset-2">
            · {t("{count} skipped", { count: formatCount(skipped) })}
          </span>
        </Tooltip>
      )}
      {plan.estimateBytes > 0 && (
        <span>· {t("about {size}", { size: formatBytes(plan.estimateBytes) })}</span>
      )}
      <span className="truncate">· {destinationText(destination, folder)}</span>
    </p>
  )
}

/** The samples: the recipe is judged on real pictures of the selection, one at a time. */
export function BatchStrip() {
  const samples = useBatchStore((s) => s.samples)
  const thumbs = useBatchStore((s) => s.thumbs)
  const current = useEditorStore((s) => s.entry?.id)
  return (
    <section
      aria-label={t("Sample pictures")}
      className="flex h-16 shrink-0 items-center gap-3 border-t border-border bg-chrome px-3"
      data-testid="batch-strip"
    >
      <ul
        role="listbox"
        aria-label={t("Sample pictures")}
        aria-orientation="horizontal"
        className="flex min-w-0 items-center gap-1.5 overflow-x-auto py-1"
        onKeyDown={(e) => {
          const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
          if (step === 0) return
          const at = samples.findIndex((s) => s.id === current)
          const next = samples[at + step]
          if (!next) return
          e.preventDefault()
          e.stopPropagation()
          selectSample(next)
          e.currentTarget.querySelector<HTMLElement>(`[data-sample="${next.id}"]`)?.focus()
        }}
      >
        {samples.map((sample, i) => {
          const selected = sample.id === current
          return (
            <li key={sample.id} role="presentation">
              <Tooltip content={sample.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={t("Sample {index}: {name}", { index: i + 1, name: sample.name })}
                  tabIndex={selected ? 0 : -1}
                  data-sample={sample.id}
                  onClick={() => selectSample(sample)}
                  className={`grid size-12 place-items-center overflow-hidden rounded-md border bg-canvas text-[0.625rem] text-muted tabular-nums ${selected ? "border-accent ring-1 ring-accent" : "border-border hover:border-muted"}`}
                >
                  {thumbs[sample.id] ? (
                    <img
                      src={thumbs[sample.id]}
                      alt=""
                      draggable={false}
                      className="size-full object-cover"
                    />
                  ) : (
                    i + 1
                  )}
                </button>
              </Tooltip>
            </li>
          )
        })}
      </ul>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.6875rem] text-muted">
          {t("The recipe is shown on samples of the selection. It runs on every picture.")}
        </p>
        <BatchSummary />
      </div>
    </section>
  )
}

const TOKENS: readonly { token: string; label: string }[] = [
  { token: "{name}", label: msg("Name") },
  { token: "{n:3}", label: msg("Number") },
  { token: "{date}", label: msg("Date") },
  { token: "{year}", label: msg("Year") },
  { token: "{folder}", label: msg("Folder") },
  { token: "{width}", label: msg("Width") },
  { token: "{height}", label: msg("Height") },
  { token: "{exif.model}", label: msg("Camera") },
]

const field =
  "h-7 w-full rounded border border-border bg-canvas px-2 text-xs outline-none focus:border-accent"

function Radio<T extends string>({
  name,
  value,
  current,
  label,
  note,
  onPick,
  children,
}: {
  name: string
  value: T
  current: T
  label: string
  note?: string
  onPick(value: T): void
  children?: React.ReactNode
}) {
  return (
    <label className="flex items-start gap-2 text-xs">
      <input
        type="radio"
        name={name}
        value={value}
        checked={current === value}
        onChange={() => onPick(value)}
        className="mt-0.5 accent-[var(--color-accent)]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          {label}
          {children}
        </span>
        {note && <span className="block text-[0.6875rem] text-muted">{note}</span>}
      </span>
    </label>
  )
}

/** Where the results go, what they are called and what they carry. */
function OutputDialog() {
  const open = useBatchStore((s) => s.dialog === "output")
  const output = useBatchStore((s) => s.output)
  const folder = useBatchStore((s) => s.folder)
  const plan = useBatchStore((s) => s.plan)
  const planning = useBatchStore((s) => s.planning)
  const error = useBatchStore((s) => s.error)
  const blocker = useBatchStore(runBlocker)
  const starting = useBatchStore((s) => s.starting)
  const defaults = useEditorSettings((s) => s.settings)
  const replace = output.destination === "replace"
  const format = replace ? "keep" : output.format
  const template = output.template ?? ""
  const insert = (token: string): void => setOutput({ template: `${template}${token}` })
  return (
    <DialogWindow
      open={open}
      onOpenChange={(o) => !o && openBatchDialog(null)}
      title={t("Output")}
      contentClassName="w-[min(30rem,calc(100vw-2rem))]"
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4" data-testid="batch-output">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium">{t("Where the results go")}</legend>
          <Radio<BatchDestination>
            name="batch-destination"
            value="beside"
            current={output.destination}
            label={t("Next to the originals")}
            onPick={(destination) => setOutput({ destination })}
          />
          <Radio<BatchDestination>
            name="batch-destination"
            value="folder"
            current={output.destination}
            label={t("In one folder")}
            onPick={(destination) => {
              setOutput({ destination })
              if (!folder) void pickFolder()
            }}
          >
            <button
              type="button"
              className="rounded border border-border px-2 py-0.5 text-[0.6875rem] hover:border-muted"
              onClick={() => void pickFolder()}
              data-testid="batch-pick-folder"
            >
              {folder ? t("Change…") : t("Choose…")}
            </button>
            {folder && (
              <span className="truncate text-[0.6875rem] text-muted" data-testid="batch-folder">
                {folder.name}
              </span>
            )}
          </Radio>
          <Radio<BatchDestination>
            name="batch-destination"
            value="replace"
            current={output.destination}
            label={t("Replace the originals")}
            note={t("Each original goes to the trash first, so you can get it back.")}
            onPick={(destination) => setOutput({ destination })}
          />
        </fieldset>

        {!replace && (
          <div className="space-y-1.5">
            <label className="block text-xs font-medium" htmlFor="batch-template">
              {t("File names")}
            </label>
            <input
              id="batch-template"
              type="text"
              value={template}
              maxLength={MAX_TEMPLATE_CHARS}
              placeholder={output.destination === "folder" ? "{name}" : "{name}-edited"}
              spellCheck={false}
              onChange={(e) => setOutput({ template: e.target.value })}
              className={field}
              data-testid="batch-template"
            />
            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-label={t("Insert into the name")}
            >
              {TOKENS.map((tk) => (
                <button
                  key={tk.token}
                  type="button"
                  onClick={() => insert(tk.token)}
                  className="rounded border border-border px-1.5 py-0.5 text-[0.6875rem] text-muted hover:border-muted hover:text-text"
                >
                  {t(tk.label)}
                </button>
              ))}
            </div>
            <Select<BatchConflict>
              label={t("When a name is taken")}
              value={output.conflict}
              options={[
                { value: "keepBoth", label: t("Keep both (add a number)") },
                { value: "skip", label: t("Skip the picture") },
                { value: "replace", label: t("Replace the file (it goes to the trash)") },
              ]}
              onChange={(conflict) => setOutput({ conflict })}
            />
          </div>
        )}

        <div className="space-y-3">
          <Select<BatchFormat>
            label={t("Format")}
            value={format}
            options={(replace ? (["keep"] as const) : BATCH_FORMATS).map((f) => ({
              value: f,
              label: formatLabel(f),
            }))}
            onChange={(f) => setOutput({ format: f })}
          />
          {(format === "jpeg" || format === "keep") && (
            <Slider
              label={format === "keep" ? t("Quality of JPEG pictures") : t("Quality")}
              value={output.quality || defaults.jpegQuality}
              min={MIN_JPEG_QUALITY}
              max={MAX_JPEG_QUALITY}
              defaultValue={defaults.jpegQuality}
              onChange={(quality) => setOutput({ quality })}
            />
          )}
          <Select<MetadataPolicy>
            label={t("Camera data (EXIF)")}
            value={output.metadata}
            options={[
              { value: "keep", label: t("Keep") },
              { value: "stripGps", label: t("Remove location only") },
              { value: "strip", label: t("Remove all") },
            ]}
            onChange={(metadata) => setOutput({ metadata })}
          />
          <NumberField
            label={t("Resolution (0 keeps the picture's)")}
            value={output.dpi ?? 0}
            min={0}
            max={MAX_DPI}
            unit="dpi"
            onChange={(dpi) => setOutput({ dpi })}
          />
        </div>

        <div className="space-y-1.5 rounded-md border border-border p-2.5" aria-live="polite">
          <p className="flex items-center gap-2 text-xs font-medium">
            {t("What will happen")}
            {planning && <Spinner size={12} />}
          </p>
          <BatchSummary />
          {plan && plan.names.length > 0 && (
            <ul className="text-[0.6875rem] text-muted" data-testid="batch-names">
              {plan.names.map((name, i) => (
                <li key={`${i}-${name}`} className="truncate">
                  {name}
                </li>
              ))}
              {plan.count > plan.names.length && <li>…</li>}
            </ul>
          )}
          {plan?.warnings.map((w) => (
            <p key={w} className="text-[0.6875rem] text-warning" data-testid="batch-warning">
              {t(WARNING_TEXT[w])}
            </p>
          ))}
          {plan?.problems.map((p, i) => (
            <p
              key={i}
              role="alert"
              className="text-[0.6875rem] text-danger"
              data-testid="batch-problem"
            >
              {problemText(p)}
            </p>
          ))}
          {error && (
            <p role="alert" className="text-[0.6875rem] text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button onClick={() => openBatchDialog(null)}>{t("Done")}</Button>
          <Tooltip content={blocker ?? ""}>
            <span>
              <Button
                variant="primary"
                disabled={blocker !== null || starting}
                onClick={() => void runBatch()}
                data-testid="batch-run-dialog"
              >
                {plan ? t("Run on {pictures}", { pictures: pictures(plan.count) }) : t("Run")}
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>
    </DialogWindow>
  )
}

const BUILTIN_NAMES: Record<string, string> = {
  web1600: msg("Web, 1600 px"),
  email1024: msg("Email, 1024 px"),
  thumb256: msg("Thumbnail, 256 px square"),
  print10x15: msg("Print, 10 × 15 cm at 300 dpi"),
  watermark: msg("Watermark, bottom right"),
  bwContrast: msg("Black and white, more contrast"),
}

export const recipeName = (r: StoredRecipe): string =>
  r.builtin && BUILTIN_NAMES[r.builtin] ? t(BUILTIN_NAMES[r.builtin]!) : r.name

/** Built-in and saved recipes: use one, save the current one, delete a saved one. */
function RecipesDialog() {
  const open = useBatchStore((s) => s.dialog === "recipes")
  const recipes = useBatchStore((s) => s.recipes)
  const steps = useEditorStore((s) => s.items.length)
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [saved, setSaved] = useState("")
  const close = (): void => {
    setError("")
    setSaved("")
    openBatchDialog(null)
  }
  const save = async (): Promise<void> => {
    const problem = await saveRecipe(name)
    setError(problem ?? "")
    if (!problem) {
      setSaved(name.trim())
      setName("")
    }
  }
  return (
    <DialogWindow
      open={open}
      onOpenChange={(o) => !o && close()}
      title={t("Recipes")}
      contentClassName="w-[min(28rem,calc(100vw-2rem))]"
    >
      <div className="space-y-3 p-4" data-testid="batch-recipes">
        <p className="text-[0.6875rem] text-muted">
          {t(
            "A recipe is the list of steps with its output settings. Using one replaces the current steps; Undo brings them back.",
          )}
        </p>
        {recipes === null ? (
          <p className="flex items-center gap-2 text-xs text-muted" role="status">
            <Spinner size={12} /> {t("Loading…")}
          </p>
        ) : (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {recipes.map((r) => {
              const label = recipeName(r)
              return (
                <li
                  key={r.builtin || r.id}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
                  data-testid="recipe"
                  data-recipe={r.builtin || r.id}
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="shrink-0 text-[0.6875rem] text-muted">
                    {r.builtin
                      ? t("built in")
                      : t("{count, plural, one {# step} other {# steps}}", {
                          count: r.recipe.ops.length,
                        })}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded border border-border px-2 py-0.5 hover:border-muted"
                    aria-label={t("Use {name}", { name: label })}
                    onClick={() => applyRecipe(r)}
                  >
                    {t("Use")}
                  </button>
                  {!r.builtin && (
                    <button
                      type="button"
                      className="shrink-0 rounded px-1.5 py-0.5 text-muted hover:text-danger"
                      aria-label={t("Delete {name}", { name: label })}
                      onClick={() => void deleteRecipe(r.id)}
                    >
                      ×
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label className="block text-xs font-medium" htmlFor="batch-recipe-name">
            {t("Save the current recipe as")}
          </label>
          <div className="flex gap-2">
            <input
              id="batch-recipe-name"
              type="text"
              value={name}
              maxLength={MAX_RECIPE_NAME_CHARS}
              onChange={(e) => {
                setName(e.target.value)
                setSaved("")
              }}
              className={field}
              data-testid="recipe-name"
            />
            <Button type="submit" disabled={name.trim() === "" || steps === 0}>
              {t("Save")}
            </Button>
          </div>
          <p className="text-[0.6875rem] text-muted">
            {steps === 0
              ? t("Add a step first: an empty recipe changes nothing.")
              : t("A recipe with the same name is replaced.")}
          </p>
          {saved && (
            <p role="status" className="text-[0.6875rem] text-muted" data-testid="recipe-saved">
              {t("Saved as {name}", { name: saved })}
            </p>
          )}
          {error && (
            <p role="alert" className="text-[0.6875rem] text-danger">
              {error}
            </p>
          )}
        </form>
        <div className="flex justify-end">
          <Button variant="primary" onClick={close}>
            {t("Done")}
          </Button>
        </div>
      </div>
    </DialogWindow>
  )
}

/** Recipes, Output and Run: what the Save controls are in batch mode. */
export function BatchControls() {
  const ready = useEditorStore((s) => s.status === "ready")
  const plan = useBatchStore((s) => s.plan)
  const starting = useBatchStore((s) => s.starting)
  const confirmReplace = useBatchStore((s) => s.dialog === "replace")
  const blocker = useBatchStore(runBlocker)
  const runHint = useShortcutHint("editor.run")
  const count = plan?.count ?? 0
  const runLabel = plan ? t("Run on {pictures}", { pictures: pictures(count) }) : t("Run")
  const title = blocker ?? (runHint ? `${runLabel} (${runHint})` : runLabel)
  return (
    <div className="flex items-center gap-1.5" data-testid="batch-controls">
      <Button size="sm" disabled={!ready} onClick={() => openBatchDialog("recipes")}>
        {t("Recipes…")}
      </Button>
      <Button
        size="sm"
        disabled={!ready}
        onClick={() => openBatchDialog("output")}
        data-testid="batch-output-open"
      >
        {t("Output…")}
      </Button>
      <Tooltip content={title}>
        <span>
          <Button
            size="sm"
            variant="primary"
            disabled={!ready || starting || !plan || plan.count === 0}
            onClick={() => void runBatch()}
            data-testid="batch-run"
          >
            {starting ? t("Starting…") : runLabel}
          </Button>
        </span>
      </Tooltip>
      <OutputDialog />
      <RecipesDialog />
      <DialogWindow
        open={confirmReplace}
        onOpenChange={(o) => !o && openBatchDialog(null)}
        title={t("Replace {pictures}?", { pictures: pictures(count) })}
        description={t(
          "Each original goes to the trash first, so you can get it back. The edited picture then takes its name.",
        )}
      >
        <div className="flex justify-end gap-2" data-testid="batch-confirm-replace">
          <Button autoFocus onClick={() => openBatchDialog(null)}>
            {t("Cancel")}
          </Button>
          <Button variant="danger" onClick={() => void runBatch(true)}>
            {t("Replace the originals")}
          </Button>
        </div>
      </DialogWindow>
    </div>
  )
}

/** Closing a recipe that was built and not run: asked once, Cancel has the focus. */
export function BatchClosePrompt() {
  const open = useEditorStore((s) => s.confirmClose)
  return (
    <DialogWindow
      open={open}
      onOpenChange={(o) => !o && cancelClose()}
      title={t("Close without running?")}
      description={t(
        "The recipe has not been run and is not saved. Save it under Recipes to use it again.",
      )}
    >
      <div className="flex justify-end gap-2" data-testid="batch-close-prompt">
        <Button
          onClick={() => {
            cancelClose()
            openBatchDialog("recipes")
          }}
        >
          {t("Recipes…")}
        </Button>
        <Button onClick={closeEditorNow}>{t("Close")}</Button>
        <Button autoFocus variant="primary" onClick={cancelClose}>
          {t("Keep editing")}
        </Button>
      </div>
    </DialogWindow>
  )
}
