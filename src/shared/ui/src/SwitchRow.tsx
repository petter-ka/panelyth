import { useId } from "react"

export function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange(value: boolean): void
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-4 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div id={`${id}-label`} className="text-xs font-medium">
          {label}
        </div>
        <div id={`${id}-description`} className="mt-0.5 text-2xs text-muted">
          {description}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative h-5 w-9 shrink-0 rounded-full bg-border transition-colors aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-raised shadow-sm transition-transform ${checked ? "translate-x-4" : ""}`}
        />
      </button>
    </div>
  )
}
