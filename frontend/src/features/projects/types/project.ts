/**
 * Project-level preferences stored in JSONB
 */
export interface ProjectPreferences {
  /** Tools disabled for this project (e.g., 'web_search', 'doc_edit') */
  disabledTools?: string[]
}

export interface Project {
  id: string
  name: string
  /** URL-friendly identifier, unique per user */
  slug: string
  /** Whether the project is marked as a favorite for quick access */
  isFavorite: boolean
  /** Custom AI instructions for the project */
  systemPrompt?: string | null
  /** Project-level settings (disabled tools, etc.) */
  preferences?: ProjectPreferences | null
  /** Last content activity timestamp (documents, folders, threads) */
  lastActivityAt: Date
  createdAt: Date
  updatedAt: Date
}
