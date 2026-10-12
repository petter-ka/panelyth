import { perLocale } from "@panelyth/i18n"

// Formatters follow the interface language and are created once per language:
// Intl constructors are expensive and these run for every visible row.
const count = perLocale((locale) => new Intl.NumberFormat(locale))
const date = perLocale(
  (locale) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
)
const units = ["B", "KB", "MB", "GB", "TB"] as const
const size = perLocale((locale) =>
  units.map((_, i) => new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 1 })),
)

export function formatCount(n: number): string {
  return count().format(n)
}

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${size()[unit]!.format(value)} ${units[unit]}`
}

export function formatDate(ms: number): string {
  return date().format(ms)
}

const percent = perLocale(
  (locale) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }),
)

/** A share (0..1) as a percentage. */
export function formatPercent(share: number): string {
  return percent().format(share)
}
