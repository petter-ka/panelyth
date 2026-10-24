import { markdownLanguage } from "@codemirror/lang-markdown"

// What a Markdown file loads on top of the editor (a chunk of its own): the
// live view, the picture resolver, pasting and dropping pictures. The preview
// (with DOMPurify) loads on its first use (./preview).
export { createImageResolver, type ImageResolver } from "./images"
export { imagesChanged, liveMarkdown } from "./live"
export { pictureInput, type PictureProgress } from "./pictures"

/** The editor's own Markdown parser (CommonMark + GFM): the preview renders its tree. */
export const markdownParser = markdownLanguage.parser
