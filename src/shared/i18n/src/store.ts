import { create } from "zustand"
import { format, type Params } from "./format"
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales"

/** One locale's translations: the English source text -> the translation. */
export type Messages = Readonly<Record<string, string>>

interface LocaleState {
  locale: Locale
  messages: Messages
}

export const useLocaleStore = create<LocaleState>(() => ({ locale: DEFAULT_LOCALE, messages: {} }))

// The translations load on demand: only the chosen language is ever in memory.
const loaders: Record<Exclude<Locale, "en">, () => Promise<{ default: Messages }>> = {
  hu: () => import("./messages/hu"),
  es: () => import("./messages/es"),
  it: () => import("./messages/it"),
  fr: () => import("./messages/fr"),
  pl: () => import("./messages/pl"),
  ru: () => import("./messages/ru"),
  de: () => import("./messages/de"),
}

const STORAGE_KEY = "panelyth.language"

function readLocal(): Locale {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isLocale(value) ? value : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

function writeLocal(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // storage unavailable; the language lasts for this session only
  }
}

async function load(locale: Locale): Promise<Messages> {
  if (locale === "en") return {}
  try {
    return (await loaders[locale]()).default
  } catch {
    return {} // a missing file shows the English source text
  }
}

/** Reflects the language on <html> for CSS, hyphenation and screen readers. */
function reflect(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale
}

/**
 * Switches the language once its translations are loaded. A call that was
 * overtaken by a later one is dropped, so the last choice always wins.
 */
let sequence = 0
export async function applyLocale(locale: Locale, remember = true): Promise<void> {
  const mine = ++sequence
  const messages = await load(locale)
  if (mine !== sequence) return
  if (remember) writeLocal(locale)
  reflect(locale)
  useLocaleStore.setState({ locale, messages })
}

/** The stored language, applied before the first render; resolves when it is ready. */
export function initLocale(): Promise<void> {
  return applyLocale(readLocal(), false)
}

export const currentLocale = (): Locale => useLocaleStore.getState().locale

/**
 * Translates an English source message. Strings are keys: a message without a
 * translation (and every message in English) shows as written.
 */
export function t(message: string, params?: Params): string {
  const { locale, messages } = useLocaleStore.getState()
  return format(messages[message] ?? message, params, locale)
}

/**
 * Marks a message for translation without translating it yet: constants
 * (menu definitions, column labels) hold the source text and pass it to t()
 * when they are shown.
 */
export const msg = (message: string): string => message

/** Tests: back to English, nothing loaded. */
export function resetLocale(): void {
  sequence++
  reflect(DEFAULT_LOCALE)
  useLocaleStore.setState({ locale: DEFAULT_LOCALE, messages: {} })
}
