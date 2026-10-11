import { applyLocale, resetLocale } from "@panelyth/i18n"
import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { FunctionKeyBar } from "./components/FunctionKeyBar"
import { describeJob } from "./components/QueuePanel"
import { formatSize } from "./features/format"
import { testResult } from "./features/archives"

// ADR-0034: the interface follows the chosen language; English is the default.

afterEach(() => {
  resetLocale()
  localStorage.clear()
})

describe("language", () => {
  it("shows English until another language is chosen", () => {
    render(<FunctionKeyBar />)
    expect(screen.getByRole("button", { name: "F5 Copy" })).toBeInTheDocument()
  })

  it("switches the interface to each language", async () => {
    const { rerender } = render(<FunctionKeyBar />)
    const names = {
      de: "F5 Kopieren",
      fr: "F5 Copier",
      es: "F5 Copiar",
      it: "F5 Copia",
      pl: "F5 Kopiuj",
      ru: "F5 Копировать",
      hu: "F5 Másolás",
    } as const
    for (const [locale, name] of Object.entries(names)) {
      await act(async () => applyLocale(locale as keyof typeof names))
      rerender(<FunctionKeyBar key={locale} />)
      expect(screen.getByRole("button", { name }), locale).toBeInTheDocument()
    }
  })

  it("uses the plural rules of the language", async () => {
    const job = (total: number) =>
      ({ kind: "copy", state: "running", total, destination: "" }) as never
    await applyLocale("ru")
    expect([1, 2, 5].map((n) => describeJob(job(n)))).toEqual([
      "Копирование 1 элемента",
      "Копирование 2 элементов",
      "Копирование 5 элементов",
    ])
    await applyLocale("pl")
    expect(describeJob(job(2))).toBe("Kopiowanie 2 elementów")
    await applyLocale("de")
    expect(testResult({ state: "completed", failed: 0, done: 1, total: 1 } as never)).toBe(
      "1 Archiv geprüft: keine Fehler.",
    )
  })

  it("formats numbers for the language", async () => {
    const item = { kind: "file", sizeBytes: 1234567 } as never
    expect(formatSize(item, "bytes")).toBe("1,234,567")
    await applyLocale("de")
    expect(formatSize(item, "bytes")).toBe("1.234.567")
  })
})
