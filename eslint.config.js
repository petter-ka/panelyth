import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

// Synchronous IPC is banned everywhere (CLAUDE.md, ADR-0002).
const noSyncIpc = {
  selector: "MemberExpression[property.name=/^(sendSync|invokeSync)$/]",
  message: "Synchronous IPC is forbidden in Panelyth.",
}

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
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The renderer never touches Electron or Node directly (NFR-07).
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["electron", "node:*"], message: "Renderer code must use src/bridge." },
          ],
        },
      ],
    },
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
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
)
