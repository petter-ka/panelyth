import { COLOR_LABELS, type ColorLabel } from "@fastview/contracts"

// Color labels (Stage 08, ADR-0022): stored as 1..7, 0 = none. Colors come
// from the --label-* tokens, so both themes keep them distinguishable.

const NAMES: Record<ColorLabel, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  gray: "Gray",
}

/** Labels in menu order with their stored values. */
export const LABELS = COLOR_LABELS.map((key, i) => ({ value: i + 1, key, name: NAMES[key] }))

export function labelKey(value: number): ColorLabel | null {
  return COLOR_LABELS[value - 1] ?? null
}

export function labelName(value: number): string {
  const key = labelKey(value)
  return key ? NAMES[key] : "None"
}

/** CSS color for a label (a token reference), or null for none. */
export function labelColor(value: number): string | null {
  const key = labelKey(value)
  return key ? `var(--label-${key})` : null
}
