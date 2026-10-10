import { defineConfig } from "vite"

// The commander's sandboxed preload: its own self-contained CommonJS file
// (a shared chunk with the viewer's preload would need a local require).
export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: false,
    target: "chrome130",
    minify: false,
    sourcemap: false,
    lib: {
      entry: "src/preload/commander.ts",
      formats: ["cjs"],
      fileName: () => "commander.cjs",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
})
