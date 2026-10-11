import { COLOR_LABELS, type ColorLabel } from "@panelyth/contracts"
import { msg, t } from "@panelyth/i18n"

// Color labels (Stage 08, ADR-0022): stored as 1..7, 0 = none. Colors come
// from the --label-* tokens, so both themes keep them distinguishable.

const NAMES: Record<ColorLabel, string> = {
  red: msg("Red"),
  orange: msg("Orange"),
  yellow: msg("Yellow"),
  green: msg("Green"),
  blue: msg("Blue"),
  purple: msg("Purple"),
  gray: msg("Gray"),
}

/** Labels in menu order with their stored values; `name` is the English source (translate with t()). */
export const LABELS = COLOR_LABELS.map((key, i) => ({ value: i + 1, key, name: NAMES[key] }))

export function labelKey(value: number): ColorLabel | null {
  return COLOR_LABELS[value - 1] ?? null
}

export function labelName(value: number): string {
  const key = labelKey(value)
  return key ? t(NAMES[key]) : t("None")
}

/** CSS color for a label (a token reference), or null for none. */
export function labelColor(value: number): string | null {
  const key = labelKey(value)
  return key ? `var(--label-${key})` : null
}
