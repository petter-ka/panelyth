// The tools of the group the rail shows (Stage 13): one header per tool,
// with the open tool's options under its header. Opening a tool closes the
// one that was open, so the panel never grows past one tool's controls.
import type { ReactNode } from "react"
import { isBatchOp } from "@panelyth/contracts"
import { Tooltip } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import { openTool, toggleOp, useEditorStore } from "../../features/editor/editorStore"
import { TOOL_GROUPS, TOOLS, type ToolId } from "../../features/editor/tools"
import {
  BlurPanel,
  ColorsPanel,
  DenoisePanel,
  GrayscalePanel,
  LevelsPanel,
  LightingPanel,
  LooksPanel,
  NegativePanel,
  ReduceColorsPanel,
  ReplaceColorPanel,
  SepiaPanel,
  SharpenPanel,
  SwapChannelsPanel,
} from "./ColorPanels"
import { CurvesPanel } from "./CurvesWidget"
import {
  BorderPanel,
  BumpPanel,
  FrameMaskPanel,
  LensPanel,
  ObscurePanel,
  OilPanel,
  SketchPanel,
  WatermarkPanel,
} from "./EffectPanels"
import { ClonePanel, DrawPanel, HealPanel, RedEyePanel } from "./RetouchPanels"
import { ToolIcon } from "./ToolIcon"
import {
  CanvasPanel,
  CropPanel,
  DpiPanel,
  FlipPanel,
  ResizePanel,
  RotatePanel,
  type CropGuide,
} from "./ToolPanels"

export interface CropOptions {
  ratioId: string
  onRatio(id: string): void
  overlay: CropGuide
  onOverlay(guide: CropGuide): void
}

function body(tool: ToolId, crop: CropOptions): ReactNode {
  switch (tool) {
    case "lighting":
      return <LightingPanel />
    case "colors":
      return <ColorsPanel />
    case "levels":
      return <LevelsPanel />
    case "curves":
      return <CurvesPanel />
    case "grayscale":
      return <GrayscalePanel />
    case "sepia":
      return <SepiaPanel />
    case "negative":
      return <NegativePanel />
    case "replaceColor":
      return <ReplaceColorPanel />
    case "swapChannels":
      return <SwapChannelsPanel />
    case "reduceColors":
      return <ReduceColorsPanel />
    case "sharpen":
      return <SharpenPanel />
    case "blur":
      return <BlurPanel />
    case "denoise":
      return <DenoisePanel />
    case "border":
      return <BorderPanel />
    case "frameMask":
      return <FrameMaskPanel />
    case "watermark":
      return <WatermarkPanel />
    case "obscure":
      return <ObscurePanel />
    case "lens":
      return <LensPanel />
    case "bump":
      return <BumpPanel />
    case "sketch":
      return <SketchPanel />
    case "oil":
      return <OilPanel />
    case "draw":
      return <DrawPanel />
    case "clone":
      return <ClonePanel />
    case "heal":
      return <HealPanel />
    case "redeye":
      return <RedEyePanel />
    case "rotate":
      return <RotatePanel />
    case "flip":
      return <FlipPanel />
    case "crop":
      return <CropPanel {...crop} />
    case "resize":
      return <ResizePanel />
    case "canvas":
      return <CanvasPanel />
    case "dpi":
      return <DpiPanel />
    case "looks":
      return <LooksPanel />
  }
}

/** The eye of the open tool's operation: the same switch as in the edit stack. */
function ActiveSwitch({ label }: { label: string }) {
  const id = useEditorStore((s) => s.activeId)
  const off = useEditorStore((s) => s.items.find((i) => i.id === s.activeId)?.op.off === true)
  if (id === null) return null
  return (
    <Tooltip content={off ? t("Switched off") : t("Switched on")}>
      <button
        type="button"
        role="switch"
        aria-checked={!off}
        aria-label={t("Apply {name}", { name: label })}
        onClick={() => toggleOp(id)}
        className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-raised hover:text-text"
      >
        <span
          aria-hidden="true"
          className={`size-2 rounded-full border border-current ${off ? "" : "bg-current"}`}
        />
      </button>
    </Tooltip>
  )
}

export function ToolList(crop: CropOptions) {
  const group = useEditorStore((s) => s.group)
  const tool = useEditorStore((s) => s.tool)
  const ready = useEditorStore((s) => s.status === "ready")
  const batch = useEditorStore((s) => s.batch)
  const label = t(TOOL_GROUPS.find((g) => g.id === group)!.label)
  return (
    <section
      aria-label={t("{group} tools", { group: label })}
      className="border-b border-border"
      data-testid="tool-panel"
      data-group={group}
      data-tool={tool ?? ""}
    >
      {TOOLS.filter((def) => def.group === group).map((def) => {
        const open = tool === def.id
        const name = t(def.label)
        // A recipe runs on pictures nobody points at: the free-hand tools stay out, and say why.
        const single = batch && def.id !== "looks" && !isBatchOp(def.id)
        return (
          <div key={def.id} className="border-b border-border last:border-b-0">
            <h2 className="flex items-center pr-2">
              <button
                type="button"
                data-tool={def.id}
                aria-expanded={open}
                aria-controls={`editor-tool-${def.id}`}
                aria-describedby={single ? `editor-tool-${def.id}-why` : undefined}
                disabled={!ready || single}
                onClick={() => openTool(open ? null : def.id)}
                className="flex h-9 min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs hover:bg-raised disabled:opacity-50 aria-expanded:font-medium aria-expanded:text-accent"
              >
                <ToolIcon id={def.id} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span aria-hidden="true" className="text-3xs text-muted">
                  {open ? "▾" : "▸"}
                </span>
              </button>
              {open && <ActiveSwitch label={name} />}
            </h2>
            {single && (
              <p
                id={`editor-tool-${def.id}-why`}
                className="px-3 pb-2 text-2xs text-muted"
                data-testid="tool-single-only"
              >
                {t("One picture at a time: this tool needs a place in the picture.")}
              </p>
            )}
            {open && (
              <div id={`editor-tool-${def.id}`} role="group" aria-label={name}>
                {body(def.id, crop)}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
