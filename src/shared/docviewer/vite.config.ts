/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { cpSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { defineConfig, type Plugin } from "vite"

// pdf.js loads its CMaps, standard fonts, ICC profiles and wasm decoders from
// URLs; they are served from this origin (ADR-0033), never from a network.
const PDFJS_DATA = ["cmaps", "standard_fonts", "iccs", "wasm"]

function pdfjsData(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))
  return {
    name: "panelyth-pdfjs-data",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0] ?? "")
        if (rel.includes("..")) return next()
        const file = join(root, rel)
        if (!existsSync(file)) return next()
        void import("node:fs").then(({ createReadStream, statSync }) => {
          if (!statSync(file).isFile()) return next()
          res.setHeader(
            "Content-Type",
            file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
          )
          createReadStream(file).pipe(res)
        })
      })
    },
    closeBundle() {
      for (const dir of PDFJS_DATA) {
        cpSync(join(root, dir), join(process.cwd(), "dist", "pdfjs", dir), { recursive: true })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsData()],
  // Served from app://documents/ in production (ADR-0033).
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: true,
    // The pdf.js worker and wasm are files, never inlined (the CSP has no data: scripts).
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5175,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
