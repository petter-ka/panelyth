type CommanderActionIconName =
  | "view"
  | "preview"
  | "edit"
  | "copy"
  | "move"
  | "mkdir"
  | "delete"
  | "search"
  | "filter"
  | "branch"
  | "refresh"
  | "star"

/** Small, consistent line icons for commander actions. */
export function CommanderActionIcon({
  name,
  className,
}: {
  name: CommanderActionIconName
  className?: string
}) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {name === "view" && (
        <>
          <path d="M1.75 8s2.25-4 6.25-4 6.25 4 6.25 4-2.25 4-6.25 4-6.25-4-6.25-4Z" />
          <circle cx="8" cy="8" r="1.75" />
        </>
      )}
      {name === "preview" && (
        <>
          <rect x="2" y="2.5" width="12" height="11" rx="1.25" />
          <path d="M7 2.75v10.5M8.5 8s.75-1.4 2.25-1.4S13 8 13 8s-.75 1.4-2.25 1.4S8.5 8 8.5 8Z" />
          <circle cx="10.75" cy="8" r=".35" />
        </>
      )}
      {name === "edit" && (
        <>
          <path d="m9.75 2.5 3.75 3.75-7.75 7.5H2v-3.75L9.75 2.5Z" />
          <path d="m8.5 3.75 3.75 3.75M2 13.75l3.75-.75" />
        </>
      )}
      {name === "copy" && (
        <>
          <rect x="5.25" y="5.25" width="8.25" height="8.25" rx="1.25" />
          <path d="M10.75 5.25v-1.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.5" />
        </>
      )}
      {name === "move" && (
        <>
          <path d="M2 4.25c0-.41.34-.75.75-.75h3.1l1.4 1.5h6c.41 0 .75.34.75.75v5.5c0 .41-.34.75-.75.75H2.75a.75.75 0 0 1-.75-.75v-7Z" />
          <path d="M5.5 8.5h5m-2-2 2 2-2 2" />
        </>
      )}
      {name === "mkdir" && (
        <>
          <path d="M1.75 4.25c0-.41.34-.75.75-.75h3.1L7 5h5.5c.41 0 .75.34.75.75v6c0 .41-.34.75-.75.75h-10a.75.75 0 0 1-.75-.75v-7.5Z" />
          <path d="M8 7.5v3m-1.5-1.5h3" />
        </>
      )}
      {name === "delete" && (
        <>
          <path d="M2.5 4.25h11m-7.75 0V2.75h4.5v1.5m-6.5 0 .6 9h5.8l.6-9" />
          <path d="M6.5 7v3.75M9.5 7v3.75" />
        </>
      )}
      {name === "search" && (
        <>
          <circle cx="7" cy="7" r="4.25" />
          <path d="m10.2 10.2 3.3 3.3" />
        </>
      )}
      {name === "filter" && <path d="M2 3h12L9.25 8.25v4.25l-2.5 1.5V8.25L2 3Z" />}
      {name === "branch" && (
        <>
          <path d="M4 3v10m0-7h3m-3 4h3" />
          <circle cx="10.5" cy="6" r="1.5" />
          <circle cx="10.5" cy="10" r="1.5" />
        </>
      )}
      {name === "refresh" && <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />}
      {name === "star" && (
        <path d="m8 2 1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4l-3.6 1.9.7-4.1-3-2.9 4.1-.6L8 2Z" />
      )}
    </svg>
  )
}

export type { CommanderActionIconName }
