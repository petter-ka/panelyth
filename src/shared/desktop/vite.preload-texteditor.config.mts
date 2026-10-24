import { defineConfig } from "vite"

// The text editor window's sandboxed preload (ADR-0046): its own self-contained CommonJS file
// (a shared chunk with the viewer's preload would need a local require).
export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: false,
    target: "chrome130",
    minify: false,
    sourcemap: false,
    lib: {
      entry: "src/preload/texteditor.ts",
      formats: ["cjs"],
      fileName: () => "texteditor.cjs",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
})
