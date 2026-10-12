// The look of text fields and selects in both apps (docs/shared/DESIGN-SYSTEM.md,
// "Form fields"): the raised surface, a border stronger than a region
// separator, so a field reads as editable on chrome, and the accent on focus.

/** Border, fill and focus of a field; the caller adds its size and padding. */
export const fieldLook =
  "rounded-md border border-muted/70 bg-raised text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent aria-invalid:border-danger"

/** The standard field of a dialog: full width, 2rem high. */
export const fieldClass = `h-8 w-full px-2 text-xs ${fieldLook}`
