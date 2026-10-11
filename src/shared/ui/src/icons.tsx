import type { ReactNode, SVGProps } from "react"
import { FLUENT_ICONS, MATERIAL_ICONS, type IconName } from "./iconPaths"
import { useIconSetStore } from "./appearance"

export type { IconName }

export type IconProps = Omit<SVGProps<SVGSVGElement>, "name"> & { size?: number }

/**
 * A chrome icon in the selected icon library (Settings → Appearance, shared
 * by both apps). `children` is the built-in default drawing (16 px grid,
 * stroked); the other libraries come from `iconPaths` (24 px grid, filled).
 */
export function Icon({
  name,
  size = 16,
  children,
  ...rest
}: IconProps & { name: IconName; children: ReactNode }) {
  const set = useIconSetStore((s) => s.iconSet)
  if (set === "default") {
    return (
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
        {...rest}
      >
        {children}
      </svg>
    )
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...rest}
    >
      <path d={(set === "fluent" ? FLUENT_ICONS : MATERIAL_ICONS)[name]} />
    </svg>
  )
}
