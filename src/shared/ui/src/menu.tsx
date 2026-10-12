// Token-styled wrappers over Radix menus (ADR-0014: Radix primitives are what
// shadcn/ui wraps). Context and dropdown menus share one look. Menus are
// portalled and mounted only while open, so they cost nothing while
// scrolling.
import * as ContextMenu from "@radix-ui/react-context-menu"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import type { ComponentProps, ReactNode } from "react"
import { CheckIcon, ChevronRightIcon } from "./icons"

const content =
  "motion-pop z-50 min-w-48 overflow-hidden rounded-md border border-border bg-raised p-1 text-xs text-text shadow-lg shadow-black/30"
const item =
  "relative flex h-7 cursor-default select-none items-center gap-2 rounded-[3px] pr-2 pl-7 outline-none data-[disabled]:text-muted data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
const separator = "my-1 h-px bg-border"
const label = "px-2 pt-1.5 pb-1 text-[0.6875rem] text-muted"
const shortcut = "ml-auto pl-6 text-[0.6875rem] opacity-70"

function Shortcut({ children }: { children?: ReactNode }) {
  return children ? <span className={shortcut}>{children}</span> : null
}

// Context menu -------------------------------------------------------------

export const ContextMenuRoot = ContextMenu.Root
export const ContextMenuTrigger = ContextMenu.Trigger

export function ContextMenuContent({
  children,
  ...rest
}: ComponentProps<typeof ContextMenu.Content>) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={content} {...rest}>
        {children}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  )
}

export function ContextMenuItem({
  children,
  shortcut: keys,
  ...rest
}: ComponentProps<typeof ContextMenu.Item> & {
  /** Hint text: the keys that do the same (an app passes its keymap's current chord). */
  shortcut?: string | undefined
}) {
  return (
    <ContextMenu.Item className={item} {...rest}>
      {children}
      <Shortcut>{keys}</Shortcut>
    </ContextMenu.Item>
  )
}

export function ContextMenuSeparator() {
  return <ContextMenu.Separator className={separator} />
}

export function ContextMenuLabel({ children }: { children: ReactNode }) {
  return <ContextMenu.Label className={label}>{children}</ContextMenu.Label>
}

export function ContextMenuSub({ label: text, children }: { label: string; children: ReactNode }) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={item}>
        {text}
        <ChevronRightIcon size={12} className="ml-auto" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={content}>{children}</ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  )
}

export const ContextMenuRadioGroup = ContextMenu.RadioGroup

export function ContextMenuRadioItem({
  children,
  ...rest
}: ComponentProps<typeof ContextMenu.RadioItem>) {
  return (
    <ContextMenu.RadioItem className={item} {...rest}>
      <ContextMenu.ItemIndicator className="absolute left-2">
        <CheckIcon size={12} />
      </ContextMenu.ItemIndicator>
      {children}
    </ContextMenu.RadioItem>
  )
}

// Dropdown menu ------------------------------------------------------------

export const DropdownRoot = DropdownMenu.Root
export const DropdownTrigger = DropdownMenu.Trigger

export function DropdownContent({
  children,
  ...rest
}: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content className={content} sideOffset={4} align="start" {...rest}>
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

export function DropdownItem({
  children,
  shortcut: keys,
  ...rest
}: ComponentProps<typeof DropdownMenu.Item> & { shortcut?: string }) {
  return (
    <DropdownMenu.Item className={item} {...rest}>
      {children}
      <Shortcut>{keys}</Shortcut>
    </DropdownMenu.Item>
  )
}

export function DropdownSeparator() {
  return <DropdownMenu.Separator className={separator} />
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className={label}>{children}</DropdownMenu.Label>
}

export const DropdownRadioGroup = DropdownMenu.RadioGroup

export function DropdownRadioItem({
  children,
  ...rest
}: ComponentProps<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem className={item} {...rest}>
      <DropdownMenu.ItemIndicator className="absolute left-2">
        <CheckIcon size={12} />
      </DropdownMenu.ItemIndicator>
      {children}
    </DropdownMenu.RadioItem>
  )
}

export function DropdownCheckboxItem({
  children,
  ...rest
}: ComponentProps<typeof DropdownMenu.CheckboxItem>) {
  return (
    <DropdownMenu.CheckboxItem className={item} {...rest}>
      <DropdownMenu.ItemIndicator className="absolute left-2">
        <CheckIcon size={12} />
      </DropdownMenu.ItemIndicator>
      {children}
    </DropdownMenu.CheckboxItem>
  )
}
