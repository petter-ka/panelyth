import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

// Synchronous IPC is banned everywhere (CLAUDE.md, ADR-0002).
const noSyncIpc = {
  selector: "MemberExpression[property.name=/^(sendSync|invokeSync)$/]",
  message: "Synchronous IPC is forbidden in Panelyth.",
}

// Package boundaries (ADR-0025, ADR-0031 "Code layout"): an app imports
// packages, never the other app; a package never imports an app, and only
// the packages below it. Renderer code never touches Electron or Node
// (NFR-07). Tested in src/shared/desktop/test/boundaries.test.ts.
const noNative = {
  group: ["electron", "node:*"],
  message: "Renderer code must use src/bridge.",
}
const pkg = (name) => [`@panelyth/${name}`, `@panelyth/${name}/*`]
const apps = {
  viewer: [...pkg("renderer"), "**/viewer/renderer/**"],
  commander: [...pkg("commander"), "**/commander/renderer/**"],
}
const noApps = {
  group: [...apps.viewer, ...apps.commander, ...pkg("desktop"), ...pkg("docviewer")],
  message: "Shared packages never import an app or the shell (ADR-0031).",
}
/** Bottom to top: each renderer package may import only the ones before it. */
const LAYERS = ["contracts", "i18n", "renderer-core", "ui", "media-ui"]
const noUpper = (name) => ({
  group: LAYERS.slice(LAYERS.indexOf(name) + 1).flatMap(pkg),
  message: `@panelyth/${name} sits below these packages (ADR-0031 "Code layout").`,
})
const restrict = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns: patterns.filter((p) => p.group.length > 0) }],
})

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "src/shared/sidecar/**",
      "src/shared/desktop/release/**",
      "src/shared/e2e/test-results/**",
      "src/shared/e2e/playwright-report/**",
      // Claude Code's agents and skills: tooling, not the product.
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-restricted-syntax": ["error", noSyncIpc],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: [
      "src/viewer/renderer/**/*.{ts,tsx}",
      "src/commander/**/*.{ts,tsx}",
      "src/shared/ui/**/*.{ts,tsx}",
    ],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["src/viewer/renderer/**/*.{ts,tsx}"],
    rules: restrict(noNative, {
      group: apps.commander,
      message: "The viewer never imports the commander; shared code lives in src/shared.",
    }),
  },
  {
    files: ["src/commander/**/*.{ts,tsx}"],
    rules: restrict(noNative, {
      group: apps.viewer,
      message: "The commander never imports the viewer; shared code lives in src/shared.",
    }),
  },
  ...LAYERS.map((name) => ({
    files: [`src/shared/${name}/src/**/*.{ts,tsx}`],
    rules: restrict(noNative, noApps, noUpper(name)),
  })),
  {
    // The window of its own for PDFs and text (ADR-0033): a renderer like the apps.
    files: ["src/shared/docviewer/src/**/*.{ts,tsx}"],
    rules: restrict(noNative, {
      group: [...apps.viewer, ...apps.commander, ...pkg("desktop")],
      message: noApps.message,
    }),
  },
  {
    // The message catalog's tooling and its test run in Node.
    files: ["src/shared/i18n/src/{cli,extract}.ts", "src/shared/i18n/src/**/*.test.ts"],
    rules: restrict(noApps, noUpper("i18n")),
  },
  {
    files: [
      "src/shared/desktop/**/*.ts",
      "scripts/**/*.mjs",
      "src/shared/e2e/**/*.ts",
      "src/shared/bench/**/*.ts",
      "src/shared/contracts/**/*.ts",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // The showcase's capture scripts run in Node and hand functions to the app's pages.
    files: ["showcase/scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
)
