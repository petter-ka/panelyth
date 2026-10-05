export const resultsDir: string
/** Unique, never-overwriting result path; requires BENCH_STAGE. */
export function resultPath(kind: string, ext?: string): string
