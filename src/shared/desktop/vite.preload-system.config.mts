import { defineConfig } from "vite"

// Panelyth System's sandboxed preload (ADR-0042): its own self-contained CommonJS file
// (a shared chunk with the viewer's preload would need a local require).
export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: false,
    target: "chrome130",
    minify: false,
    sourcemap: false,
    lib: {
      entry: "src/preload/system.ts",
      formats: ["cjs"],
      fileName: () => "system.cjs",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
})
