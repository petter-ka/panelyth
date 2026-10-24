import { LanguageSupport } from "@codemirror/language"
import { describe, expect, it } from "vitest"
import { languageFor } from "./languages"

describe("languageFor", () => {
  it.each([
    ["README.md", "Markdown"],
    ["README.MD", "Markdown"],
    ["notes.markdown", "Markdown"],
    ["package.json", "JSON"],
    ["tsconfig.jsonc", "JSON"],
    ["docker-compose.yml", "YAML"],
    ["config.yaml", "YAML"],
    ["Cargo.toml", "TOML"],
    ["settings.ini", "INI"],
    ["setup.cfg", "INI"],
    [".editorconfig", "INI"],
    [".env", "INI"],
    [".env.local", "INI"],
    ["page.html", "HTML"],
    ["feed.xml", "XML"],
    ["App.csproj", "XML"],
    ["site.css", "CSS"],
    ["app.js", "JavaScript"],
    ["app.ts", "TypeScript"],
    ["main.py", "Python"],
    ["main.go", "Go"],
    ["deploy.sh", "Shell"],
    [".bashrc", "Shell"],
    ["init.zsh", "Shell"],
    ["schema.sql", "SQL"],
  ])("%s is %s", (name, language) => {
    expect(languageFor(name)?.name).toBe(language)
  })

  it("is null (plain text) for text and unknown files", () => {
    expect(languageFor("notes.txt")).toBeNull()
    expect(languageFor("LICENSE")).toBeNull()
    expect(languageFor("data.unknownext")).toBeNull()
  })

  it("loads a language on first use", async () => {
    for (const name of ["README.md", "Cargo.toml", "settings.ini", "deploy.sh", "a.json"]) {
      const support = await languageFor(name)!.load()
      expect(support, name).toBeInstanceOf(LanguageSupport)
    }
  })
})
