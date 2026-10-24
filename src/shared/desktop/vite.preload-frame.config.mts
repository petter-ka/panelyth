import { defineConfig } from "vite"

// The document window's sandboxed preload (ADR-0033, ADR-0045): its own self-contained CommonJS file
// (a shared chunk with the viewer's preload would need a local require).
export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: false,
    target: "chrome130",
    minify: false,
    sourcemap: false,
    lib: {
      entry: "src/preload/frame.ts",
      formats: ["cjs"],
      fileName: () => "frame.cjs",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
})
