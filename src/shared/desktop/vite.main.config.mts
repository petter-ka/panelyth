import { builtinModules } from "node:module"
import { defineConfig } from "vite"

// Electron main process: a single CommonJS bundle for Node. Workspace
// packages (contracts) are bundled; electron and Node builtins stay external.
export default defineConfig({
  build: {
    outDir: "dist/main",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    lib: {
      entry: "src/main/index.ts",
      formats: ["cjs"],
      fileName: () => "main.cjs",
    },
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    },
  },
})
