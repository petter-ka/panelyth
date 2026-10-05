// Formatters are created once: Intl constructors are expensive and these run
// for every visible row.
const count = new Intl.NumberFormat()
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
const units = ["B", "KB", "MB", "GB", "TB"] as const
const size = units.map(
  (_, i) => new Intl.NumberFormat(undefined, { maximumFractionDigits: i === 0 ? 0 : 1 }),
)

export function formatCount(n: number): string {
  return count.format(n)
}

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${size[unit]!.format(value)} ${units[unit]}`
}

export function formatDate(ms: number): string {
  return date.format(ms)
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`
}
