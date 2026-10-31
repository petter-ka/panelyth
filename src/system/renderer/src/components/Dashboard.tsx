import type { Volume, VolumeKind } from "@panelyth/contracts"
import { msg, t } from "@panelyth/i18n"
import type { ReactNode } from "react"
import {
  formatBytes,
  formatClock,
  formatCount,
  formatPercent,
  formatUptime,
} from "../features/format"
import { useSystemStore } from "../features/system"
import { CoreBars, Meter, Ring, Sparkline } from "./Charts"

/** A dashboard card: a glass card in the glass style, chrome on the canvas otherwise. */
export function Card({
  title,
  icon,
  aside,
  className = "",
  children,
  testId,
}: {
  title: string
  icon: ReactNode
  aside?: ReactNode
  className?: string
  children: ReactNode
  testId?: string
}) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className={`glass-region flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-chrome p-4 ${className}`}
    >
      <header className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-lg text-accent"
          style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}
        >
          {icon}
        </span>
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        {aside && <div className="ml-auto min-w-0 truncate text-2xs text-muted">{aside}</div>}
      </header>
      {children}
    </section>
  )
}

/** A bar where a value will be until it is read (styles.css, "Skeletons"). */
function Bone({ className }: { className: string }) {
  return <span aria-hidden="true" className={`skeleton-bone ${className}`} />
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

export const CpuIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
    <path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" />
  </svg>
)
export const MemoryIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <rect x="1.5" y="4.5" width="13" height="6" rx="1" />
    <path d="M4 10.5v2M7 10.5v2M10 10.5v2M13 10.5v2M4.5 7h1M7.5 7h1M10.5 7h1" />
  </svg>
)
export const DiskIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
    <path d="M4 9.5h5M11.5 9.5h.5" />
  </svg>
)
export const GpuIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
    <circle cx="10.5" cy="8" r="2" />
    <path d="M4 6.5h2.5M4 9.5h2.5M3.5 12v1.5" />
  </svg>
)

/** The computer's name, its OS and how long it has been up; a live mark while sampling. */
export function Header() {
  const hardware = useSystemStore((s) => s.hardware)
  const failed = useSystemStore((s) => s.hardwareFailed)
  const sampling = useSystemStore((s) => s.sample !== null)
  const reading = !hardware && !failed
  return (
    <header className="flex min-w-0 flex-wrap items-end justify-between gap-3 px-1">
      <div className="min-w-0">
        <p className="text-2xs text-muted">{t("This computer")}</p>
        <h1 className="truncate text-2xl font-semibold tracking-tight" data-testid="hostname">
          {hardware?.hostname ??
            (reading ? (
              <span className="flex h-8 items-center">
                <Bone className="h-6 w-40 rounded-md" />
                <span className="sr-only">{t("Loading…")}</span>
              </span>
            ) : (
              "…"
            ))}
        </h1>
        <p className="truncate text-xs text-muted" data-testid="os">
          {failed ? (
            t("Couldn't read this computer's details.")
          ) : hardware ? (
            [
              hardware.os.name,
              hardware.os.arch,
              t("Up for {time}", { time: formatUptime(hardware.uptimeMs) }),
            ].join(" · ")
          ) : (
            <span className="flex h-4 items-center">
              <Bone className="w-56" />
            </span>
          )}
        </p>
      </div>
      {sampling && (
        <span
          className="glass-chip relative flex items-center gap-2 rounded-full border border-border bg-chrome-solid px-3 py-1 text-2xs text-muted"
          data-testid="live"
        >
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          {t("Live")}
        </span>
      )}
    </header>
  )
}

/** The value in a ring's middle: big, with a small caption under it. */
function RingValue({ value, caption }: { value: string; caption: string }) {
  return (
    <span className="flex flex-col items-center leading-tight">
      <span className="text-xl font-semibold prose-nums">{value}</span>
      <span className="text-3xs text-muted">{caption}</span>
    </span>
  )
}

export function CpuCard() {
  const hardware = useSystemStore((s) => s.hardware)
  const history = useSystemStore((s) => s.history)
  const now = history.at(-1)
  return (
    <Card
      title={t("Processor")}
      icon={<CpuIcon />}
      aside={hardware?.cpu.model ?? <Bone className="ml-auto w-40" />}
      testId="cpu-card"
    >
      <div className="flex items-center gap-4">
        <Ring value={now?.cpu ?? 0} label={t("Processor load")}>
          <RingValue value={now ? formatPercent(now.cpu) : "–"} caption={t("Load")} />
        </Ring>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-2xs text-muted">{t("Last minute")}</p>
          <Sparkline values={history.map((p) => p.cpu)} label={t("Processor load, last minute")} />
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-2xs text-muted">{t("Per processor")}</p>
        {now ? (
          <CoreBars cores={now.cores} label={t("Load of each logical processor")} />
        ) : (
          <Bone className="h-12 w-full rounded-md" />
        )}
      </div>
      {hardware ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted prose-nums">
          <span>{t("Logical processors: {count}", { count: hardware.cpu.threads })}</span>
          {hardware.cpu.speedMhz > 0 && (
            <span>{t("Clock: {speed}", { speed: formatClock(hardware.cpu.speedMhz) })}</span>
          )}
        </p>
      ) : (
        <Bone className="w-48" />
      )}
    </Card>
  )
}

export function MemoryCard() {
  const hardware = useSystemStore((s) => s.hardware)
  const history = useSystemStore((s) => s.history)
  const now = history.at(-1)
  const total = now?.totalBytes ?? hardware?.memoryBytes ?? 0
  return (
    <Card
      title={t("Memory")}
      icon={<MemoryIcon />}
      aside={total > 0 ? formatBytes(total) : undefined}
      testId="memory-card"
    >
      <div className="flex items-center gap-4">
        <Ring value={now?.memory ?? 0} label={t("Memory in use")} color="var(--label-blue)">
          <RingValue value={now ? formatPercent(now.memory) : "–"} caption={t("In use")} />
        </Ring>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-2xs text-muted">{t("Last minute")}</p>
          <Sparkline
            values={history.map((p) => p.memory)}
            color="var(--label-blue)"
            label={t("Memory in use, last minute")}
          />
        </div>
      </div>
      {now ? (
        <p className="text-2xs text-muted prose-nums">
          {t("{used} of {total} in use, {free} free", {
            used: formatBytes(now.usedBytes),
            total: formatBytes(now.totalBytes),
            free: formatBytes(now.totalBytes - now.usedBytes),
          })}
        </p>
      ) : (
        <Bone className="w-48" />
      )}
    </Card>
  )
}

export function GpuCard() {
  const hardware = useSystemStore((s) => s.hardware)
  const failed = useSystemStore((s) => s.hardwareFailed)
  const gpus = hardware?.gpus ?? []
  return (
    <Card
      title={t("Graphics")}
      icon={<GpuIcon />}
      className="md:col-span-2 xl:col-span-1"
      testId="gpu-card"
    >
      {hardware && gpus.length === 0 && (
        <p className="text-xs text-muted">{t("No graphics adapter was found.")}</p>
      )}
      {!hardware && !failed && (
        <div className="flex flex-col gap-3" data-testid="gpu-reading">
          <Bone className="h-3 w-48" />
          <Bone className="w-32" />
          <Bone className="h-3 w-40" />
          <Bone className="w-28" />
        </div>
      )}
      <ul className="space-y-3">
        {gpus.map((gpu, i) => (
          <li key={`${gpu.name}-${i}`} className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{gpu.name}</span>
              {gpu.active && (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-3xs font-medium text-accent"
                  style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}
                >
                  {t("In use")}
                </span>
              )}
            </div>
            <p className="truncate text-2xs text-muted">
              {[gpu.vendor, gpu.driver && t("Driver: {version}", { version: gpu.driver })]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      {hardware && (
        <p className="mt-auto text-2xs text-muted prose-nums">
          {[hardware.os.name, hardware.os.release].join(" · ")}
        </p>
      )}
    </Card>
  )
}

const KIND_LABELS: Record<VolumeKind, string> = {
  fixed: msg("Local disk"),
  removable: msg("Removable"),
  network: msg("Network"),
  optical: msg("Optical"),
  other: msg("Other"),
}

/** A volume's size is known: it answered and reported its space. */
export const measured = (v: Volume): v is Volume & { totalBytes: number; freeBytes: number } =>
  !v.notReady && (v.totalBytes ?? 0) > 0 && v.freeBytes !== undefined

export function StorageCard() {
  const volumes = useSystemStore((s) => s.volumes)
  const failed = useSystemStore((s) => s.volumesFailed)
  const sized = (volumes ?? []).filter(measured)
  const total = sized.reduce((sum, v) => sum + v.totalBytes, 0)
  const free = sized.reduce((sum, v) => sum + v.freeBytes, 0)
  const used = total > 0 ? (total - free) / total : 0
  const reading = volumes === null && !failed
  return (
    <Card
      title={t("Storage")}
      icon={<DiskIcon />}
      aside={
        total > 0
          ? t("{free} free of {total}", { free: formatBytes(free), total: formatBytes(total) })
          : undefined
      }
      className="md:col-span-2 xl:col-span-3"
      testId="storage-card"
    >
      {failed && <p className="text-xs text-danger">{t("Couldn't read the volumes.")}</p>}
      <div className="flex flex-wrap items-center gap-6">
        <Ring value={used} size={128} stroke={12} label={t("Storage in use, all volumes")}>
          <RingValue value={reading ? "–" : formatPercent(used)} caption={t("Used")} />
        </Ring>
        <ul className="grid min-w-0 flex-1 gap-3 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
          {reading &&
            [0, 1, 2].map((i) => (
              <li key={i} aria-hidden="true" className="flex min-w-0 flex-col gap-2">
                <Bone className="w-24" />
                <Bone className="h-2 w-full" />
                <Bone className="w-20" />
              </li>
            ))}
          {(volumes ?? []).map((v) => {
            const share = measured(v) ? (v.totalBytes - v.freeBytes) / v.totalBytes : 0
            return (
              <li key={v.path} className="min-w-0 space-y-1.5" data-testid="volume">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-xs font-semibold">{v.path}</span>
                  {/* The label, and the kind beside it; the kind alone names an unlabelled volume. */}
                  <span className="truncate text-xs">{v.label || t(KIND_LABELS[v.kind])}</span>
                  {v.label && (
                    <span className="ml-auto shrink-0 text-3xs text-muted">
                      {t(KIND_LABELS[v.kind])}
                    </span>
                  )}
                </div>
                {measured(v) ? (
                  <>
                    <Meter value={share} label={t("{volume} in use", { volume: v.path })} />
                    <p className="text-3xs text-muted prose-nums">
                      {t("{free} free of {total}", {
                        free: formatBytes(v.freeBytes),
                        total: formatBytes(v.totalBytes),
                      })}
                    </p>
                  </>
                ) : (
                  <p className="text-3xs text-muted">{t("Not ready")}</p>
                )}
              </li>
            )
          })}
        </ul>
      </div>
      {volumes && (
        <p className="text-3xs text-muted prose-nums">
          {t("Volumes: {count}", { count: formatCount(volumes.length) })}
        </p>
      )}
    </Card>
  )
}
