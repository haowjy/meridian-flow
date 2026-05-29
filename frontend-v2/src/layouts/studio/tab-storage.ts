import type { TabBarTab } from "@/components/ui/tab-bar"

const STORAGE_PREFIX = "meridian:tabs:studio:"

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`
}

/** Persist only non-preview tabs. Preview tabs are ephemeral. */
export function readPersistedTabs(
  projectId: string,
  fallback: TabBarTab[],
): TabBarTab[] {
  if (typeof window === "undefined") return fallback
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as TabBarTab[]
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback
    // Strip any preview/dirty flags — on reload everything starts clean
    return parsed.map((tab) => ({
      id: tab.id,
      label: tab.label,
      isPinned: tab.isPinned,
    }))
  } catch {
    return fallback
  }
}

export function writePersistedTabs(
  projectId: string,
  tabs: TabBarTab[],
): void {
  try {
    const persistent = tabs.filter((tab) => !tab.isPreview)
    localStorage.setItem(storageKey(projectId), JSON.stringify(persistent))
  } catch {
    // Ignore quota / private mode failures
  }
}
