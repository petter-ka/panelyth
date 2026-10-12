export interface NoticeMessage {
  /** A new id restarts the announcement and the entrance. */
  id: number
  text: string
  tone: "info" | "error"
}

/** A short status message above the status bar, also over a full-window overlay. */
export function Notice({ notice }: { notice: NoticeMessage | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-10 z-[60] flex justify-center px-4"
    >
      {notice && (
        <span
          key={notice.id}
          data-testid="notice"
          data-tone={notice.tone}
          className={`max-w-full truncate rounded-md border bg-chrome px-3 py-1.5 text-xs shadow-md ${
            notice.tone === "error" ? "border-danger text-danger" : "border-border text-text"
          }`}
        >
          {notice.text}
        </span>
      )}
    </div>
  )
}
