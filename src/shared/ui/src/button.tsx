// Token-styled button (ADR-0014; shadcn/ui's Button shape without its
// class-variance dependency). Variants are the looks the app already used,
// collected in one place so new UI does not invent more.
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { Tooltip } from "./Tooltip"

export type ButtonVariant = "primary" | "secondary" | "danger" | "toolbar"
export type ButtonSize = "md" | "sm" | "icon"

const base = "rounded-md text-xs disabled:opacity-50"

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground",
  secondary: "border border-border hover:border-muted",
  danger: "border border-danger text-danger hover:bg-raised",
  // Raised controls in toolbars; aria-pressed marks toggles.
  toolbar:
    "border border-border bg-raised enabled:hover:border-muted aria-pressed:border-accent aria-pressed:text-accent",
}

const sizes: Record<ButtonSize, string> = {
  md: "h-8 px-3",
  sm: "h-7 px-2.5",
  icon: "grid size-7 place-items-center",
}

/** Class names for a button look (for elements that cannot use <Button>). */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string {
  return `${base} ${sizes[size]} ${variants[variant]}`
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  title,
  ...rest
}: ButtonProps) {
  const button = (
    <button
      type={type}
      className={
        className ? `${buttonClass(variant, size)} ${className}` : buttonClass(variant, size)
      }
      {...rest}
    />
  )
  return title ? <Tooltip content={title}>{button}</Tooltip> : button
}

/** A key cap, for shortcut references. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-raised px-1 font-mono text-2xs text-text tabular-nums">
      {children}
    </kbd>
  )
}
