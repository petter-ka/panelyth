import { currentLocale } from "./store"

/**
 * A value built for the current language (an Intl formatter), created once
 * per language and reused: formatters are expensive and run for every row.
 */
export function perLocale<T>(make: (locale: string) => T): () => T {
  const cache = new Map<string, T>()
  return () => {
    const locale = currentLocale()
    let value = cache.get(locale)
    if (value === undefined) {
      value = make(locale)
      cache.set(locale, value)
    }
    return value
  }
}
