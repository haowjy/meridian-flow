const STORAGE_PREFIX = "meridian:panels:"

export function readPanelSize(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`)
    if (raw == null) return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

export function writePanelSize(key: string, value: number): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, String(Math.round(value)))
  } catch {
    // Ignore quota / private mode failures for mock shell.
  }
}
