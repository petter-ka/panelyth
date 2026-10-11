import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { extractMessages } from "./extract"
import { format, placeholders, pluralForms } from "./format"
import { LOCALES, type Locale } from "./locales"
import type { Messages } from "./store"

const SRC = join(__dirname, "..", "..", "..")
const source = extractMessages(SRC)

// The plural categories each language needs (CLDR, integers).
const PLURALS: Record<Locale, string[]> = {
  en: ["one", "other"],
  hu: ["one", "other"],
  es: ["one", "many", "other"],
  it: ["one", "many", "other"],
  fr: ["one", "many", "other"],
  pl: ["one", "few", "many", "other"],
  ru: ["one", "few", "many", "other"],
  de: ["one", "other"],
}

async function messagesOf(locale: Locale): Promise<Messages> {
  return (await import(`./messages/${locale}.ts`)).default as Messages
}

describe("source messages", () => {
  it("are all valid messages", () => {
    for (const message of source.keys()) {
      expect(() => placeholders(message), message).not.toThrow()
      for (const forms of pluralForms(message)) {
        // English source: one + other (an "=0" branch may be added)
        expect(forms.sort(), message).toEqual(["one", "other"])
      }
    }
  })

  it("find the app's strings", () => {
    expect(source.size).toBeGreaterThan(100)
  })
})

describe.each(LOCALES.filter((l) => l !== "en"))("%s", (locale) => {
  it("translates every message, and nothing stale", async () => {
    const messages = await messagesOf(locale)
    const missing = [...source.keys()].filter((m) => !(m in messages))
    const stale = Object.keys(messages).filter((m) => !source.has(m))
    expect(missing, `missing in ${locale}`).toEqual([])
    expect(stale, `stale in ${locale}`).toEqual([])
  })

  it("keeps the placeholders and has the plural forms of the language", async () => {
    const messages = await messagesOf(locale)
    for (const [message, translated] of Object.entries(messages)) {
      expect(placeholders(translated), `${locale}: ${message}`).toEqual(placeholders(message))
      const sourceForms = pluralForms(message).length
      const forms = pluralForms(translated)
      expect(forms.length, `${locale}: ${message}`).toBe(sourceForms)
      for (const f of forms) {
        const needed = PLURALS[locale]
        expect(
          needed.every((c) => f.includes(c)),
          `${locale} plural forms ${f.join(",")} of: ${translated}`,
        ).toBe(true)
      }
      // It formats without throwing for a few numbers.
      const params = Object.fromEntries(placeholders(message).map((p) => [p, 3]))
      for (const n of [0, 1, 2, 5, 21]) {
        const withN = Object.fromEntries(Object.keys(params).map((k) => [k, n]))
        expect(() => format(translated, withN, locale)).not.toThrow()
      }
    }
  })
})
