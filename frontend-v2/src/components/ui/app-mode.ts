/** App shell mode — shared by Rail and BottomNav. */
export type AppMode = "agents" | "converse" | "studio"

export const APP_MODES: AppMode[] = ["agents", "converse", "studio"]

export const APP_MODE_LABELS: Record<AppMode, string> = {
  agents: "Agents",
  converse: "Converse",
  studio: "Studio",
}

/** Mod+1/2/3 shortcuts shown in tooltips. */
export const APP_MODE_SHORTCUTS: Record<AppMode, string> = {
  agents: "⌘1",
  converse: "⌘2",
  studio: "⌘3",
}
