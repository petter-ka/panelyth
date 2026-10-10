import { defineConfig } from "vite"

// Sandboxed preload: must be one self-contained CommonJS file. Only
// `electron` may be required at runtime.
export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    target: "chrome130",
    minify: false,
    sourcemap: false,
    lib: {
      entry: "src/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
})
