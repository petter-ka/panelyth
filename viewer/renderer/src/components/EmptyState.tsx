import type { ReactNode } from "react"

interface EmptyStateProps {
  title: string
  description?: string
  tone?: "neutral" | "danger"
  action?: ReactNode
}

export function EmptyState({ title, description, tone = "neutral", action }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <h2 className={tone === "danger" ? "text-sm font-medium text-danger" : "text-sm font-medium"}>
        {title}
      </h2>
      {description && <p className="max-w-sm text-xs leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
