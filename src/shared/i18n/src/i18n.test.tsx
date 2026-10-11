import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { format, placeholders, pluralForms } from "./format"
import { LocaleBoundary } from "./LocaleBoundary"
import { applyLocale, initLocale, msg, resetLocale, t, useLocaleStore } from "./index"

afterEach(() => {
  resetLocale()
  localStorage.clear()
})

describe("format", () => {
  it("fills placeholders and leaves unknown ones visible", () => {
    expect(format("Delete {name}?", { name: "a.txt" }, "en")).toBe("Delete a.txt?")
    expect(format("Hello {who}", {}, "en")).toBe("Hello {who}")
    expect(format("No placeholders", undefined, "en")).toBe("No placeholders")
  })

  it("chooses plural forms by the language's rules, with # as the number", () => {
    const en = "{count, plural, =0 {No files} one {# file} other {# files}}"
    expect(format(en, { count: 0 }, "en")).toBe("No files")
    expect(format(en, { count: 1 }, "en")).toBe("1 file")
    expect(format(en, { count: 1234 }, "en")).toBe("1,234 files")
    const ru = "{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}"
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => format(ru, { n }, "ru"))).toEqual([
      "1 файл",
      "2 файла",
      "5 файлов",
      "11 файлов",
      "21 файл",
      "22 файла",
      "25 файлов",
    ])
    const pl = "{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}"
    expect([1, 2, 5, 12, 22].map((n) => format(pl, { n }, "pl"))).toEqual([
      "1 plik",
      "2 pliki",
      "5 plików",
      "12 plików",
      "22 pliki",
    ])
  })

  it("nests placeholders inside plural branches", () => {
    const m =
      "{count, plural, one {Delete # file from {folder}?} other {Delete # files from {folder}?}}"
    expect(format(m, { count: 3, folder: "/tmp" }, "en")).toBe("Delete 3 files from /tmp?")
  })

  it("lists placeholders and plural forms for the completeness check", () => {
    const m = "{count, plural, one {# of {total}} other {# of {total}}} in {folder}"
    expect(placeholders(m)).toEqual(["count", "folder", "total"])
    expect(pluralForms(m)).toEqual([["one", "other"]])
  })

  it("rejects what it does not support", () => {
    expect(() => format("{a, select, x {y} other {z}}", { a: 1 }, "en")).toThrow()
    expect(() => format("{n, plural, one {x}}", { n: 1 }, "en")).toThrow()
    expect(() => format("oops {", {}, "en")).toThrow()
  })
})

describe("t", () => {
  it("shows the English source in English and for a message without a translation", async () => {
    expect(t("Open folder")).toBe("Open folder")
    await applyLocale("de")
    expect(t("A message nobody translated")).toBe("A message nobody translated")
  })

  it("marks messages without translating them", () => {
    expect(msg("Name")).toBe("Name")
  })

  it("remembers the language and reflects it on <html>", async () => {
    await applyLocale("fr")
    expect(useLocaleStore.getState().locale).toBe("fr")
    expect(localStorage.getItem("panelyth.language")).toBe("fr")
    expect(document.documentElement.lang).toBe("fr")
    resetLocale()
    await initLocale()
    expect(useLocaleStore.getState().locale).toBe("fr")
  })

  it("ignores an unknown stored language and lets the last choice win", async () => {
    localStorage.setItem("panelyth.language", "klingon")
    await initLocale()
    expect(useLocaleStore.getState().locale).toBe("en")
    const first = applyLocale("de")
    const second = applyLocale("es")
    await Promise.all([first, second])
    expect(useLocaleStore.getState().locale).toBe("es")
  })
})

describe("LocaleBoundary", () => {
  it("remounts the tree when the language changes", async () => {
    let mounts = 0
    function Probe() {
      mounts++
      return <p>{t("Name")}</p>
    }
    render(
      <LocaleBoundary>
        <Probe />
      </LocaleBoundary>,
    )
    expect(screen.getByText("Name")).toBeTruthy()
    const before = mounts
    await act(async () => applyLocale("it"))
    expect(mounts).toBeGreaterThan(before)
  })
})
