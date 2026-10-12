import { defineConfig } from "vite"

// Relative asset URLs: the built page works at a domain's root and under a
// project path (GitHub Pages serves it at /panelyth/) alike.
export default defineConfig({ base: "./" })
