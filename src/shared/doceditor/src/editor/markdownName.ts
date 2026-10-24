import { isMarkdownName, MARKDOWN_EXTS } from "@panelyth/contracts"

// Main and the page agree on what is Markdown (contracts/src/documents.ts):
// main opens it read-only on F3, the page shows the mode switch.

/** The extensions of Markdown files, for the language list. */
export const MARKDOWN_EXTENSIONS: readonly string[] = [...MARKDOWN_EXTS]

export { isMarkdownName }
