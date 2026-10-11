/** The languages the apps are translated into; English is the source and the default (ADR-0034). */
export const LOCALES = ["en", "hu", "es", "it", "fr", "pl", "ru", "de"] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "en"

/** Each language in its own language, for the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  hu: "Magyar",
  es: "Español",
  it: "Italiano",
  fr: "Français",
  pl: "Polski",
  ru: "Русский",
  de: "Deutsch",
}

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (LOCALES as readonly string[]).includes(value)
