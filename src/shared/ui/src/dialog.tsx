// Token-styled Radix dialog (ADR-0014). Focus is trapped while open and
// returns to the trigger on close; Esc closes.
import * as Dialog from "@radix-ui/react-dialog"
import type { ReactNode } from "react"
import { t } from "@panelyth/i18n"

const CloseIcon = ({ size }: { size: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
)

/** A down arrow: the dialog goes away, its work goes on (the commander's progress dialog). */
const MinimizeIcon = ({ size }: { size: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m4 6 4 4 4-4" />
  </svg>
)

interface Props {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  description?: string
  children: ReactNode
  contentClassName?: string
  /** Call preventDefault() to keep the dialog open (e.g. while recording keys). */
  onEscapeKeyDown?: (e: KeyboardEvent) => void
  /** The title bar's button: a close ×, or a down arrow that minimizes (with its own label). */
  minimize?: { label: string; testId?: string }
}

export function DialogWindow({
  open,
  onOpenChange,
  title,
  description,
  children,
  contentClassName,
  onEscapeKeyDown,
  minimize,
}: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="glass-scrim motion-fade fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          {...(onEscapeKeyDown ? { onEscapeKeyDown } : {})}
          className={`motion-pop fixed top-1/2 left-1/2 z-50 ${contentClassName ?? "w-[min(28rem,calc(100vw-2rem))]"} -translate-x-1/2 -translate-y-1/2 glass-sheet rounded-lg border border-border bg-chrome text-text shadow-xl shadow-black/40 outline-none`}
        >
          <div className="flex h-11 items-center gap-2 border-b border-border pr-2 pl-4">
            <Dialog.Title className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={minimize ? minimize.label : t("Close")}
              {...(minimize && { title: minimize.label, "data-testid": minimize.testId })}
              className="glass-pill grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-text"
            >
              {minimize ? <MinimizeIcon size={16} /> : <CloseIcon size={14} />}
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className="px-4 pt-3 text-xs text-muted">
              {description}
            </Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{title}</Dialog.Description>
          )}
          <div className="p-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
