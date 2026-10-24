import DOMPurify from "dompurify"

// The one cleaning of rendered Markdown (markdown/html.ts) before it reaches a
// page: Preview and the PDF export's print view use the same rules.

/** Only the read-only tokens resolveImages gives may be a picture's src. */
const TOKEN = /^panelyth-media:\/\/m\/[0-9a-f]{32}$/

/** The tags and attributes markdown/html.ts writes; nothing else survives. */
const PURIFY = {
  ALLOWED_TAGS: [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "em",
    "strong",
    "del",
    "sub",
    "sup",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "hr",
    "a",
    "img",
    "br",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "input",
    "span",
    "div",
  ],
  ALLOWED_ATTR: [
    "href",
    "title",
    "src",
    "alt",
    "class",
    "data-line",
    "type",
    "checked",
    "disabled",
    "start",
  ],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP:
    /^(?:https?:|mailto:|panelyth-media:|[^a-z]|[a-z][a-z0-9+.-]*(?:[^a-z0-9+.:-]|$))/i,
}

let hooked = false
function installHooks(): void {
  if (hooked) return
  hooked = true
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "IMG") {
      // A picture without a token becomes its placeholder, never a request.
      const src = node.getAttribute("src") ?? ""
      if (!TOKEN.test(src)) {
        const span = node.ownerDocument.createElement("span")
        span.className = "md-image-placeholder md-image-missing"
        span.textContent = node.getAttribute("alt") ?? ""
        node.replaceWith(span)
      }
    } else if (node.nodeName === "INPUT") {
      // Task boxes only, and read-only.
      if (node.getAttribute("type") !== "checkbox") node.remove()
      else node.setAttribute("disabled", "")
    }
  })
}

export function sanitize(html: string): string {
  installHooks()
  return DOMPurify.sanitize(html, PURIFY) as string
}
