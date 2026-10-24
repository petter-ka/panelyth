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
    // The switch first, as the settings' other switches and radios line up on the left.
    <div className="flex items-start gap-3 border-b border-border py-3 last:border-b-0">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        // The switch is drawn by styles.css ("Settings controls"), as the settings' checkboxes are.
        className="ui-switch mt-px"
      />
      <div className="min-w-0 flex-1">
        <div id={`${id}-label`} className="text-xs font-medium">
          {label}
        </div>
        <div id={`${id}-description`} className="mt-0.5 text-2xs text-muted">
          {description}
        </div>
      </div>
    </div>
  )
}
