import { currentLocale } from "@panelyth/i18n"

// Numbers, sizes and durations in the interface language (Intl): no unit
// names to translate.

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte", "petabyte"] as const

/** 1.5 GB, 931 GB, 12 KB: binary steps, one decimal under 100. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return new Intl.NumberFormat(currentLocale(), {
    style: "unit",
    unit: UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1,
  }).format(value)
}

/** 0.42 → "42%" as the language writes it. */
export function formatPercent(fraction: number): string {
  return new Intl.NumberFormat(currentLocale(), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(Math.min(1, Math.max(0, fraction)))
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat(currentLocale()).format(n)
}

/** 3600 MHz → "3.6 GHz". */
export function formatClock(mhz: number): string {
  return `${new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 2 }).format(mhz / 1000)} GHz`
}

interface DurationFormat {
  format(duration: Record<string, number>): string
}

/** Uptime: days, hours and minutes ("3 d 4 h 12 min"), in the language's own short form. */
export function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const parts = { days, hours, minutes: minutes % 60 }
  const Duration = (
    Intl as unknown as { DurationFormat?: new (l: string, o: object) => DurationFormat }
  ).DurationFormat
  if (Duration) return new Duration(currentLocale(), { style: "narrow" }).format(parts)
  return `${days}d ${hours}h ${parts.minutes}m`
}
