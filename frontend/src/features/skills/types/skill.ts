/**
 * Skill represents a project skill's metadata
 */
export interface Skill {
  id: string
  projectId: string
  name: string // Internal identifier (e.g., "writing-coach")
  displayName: string // User-facing display name
  description: string
  position: number // Sort order for display
  disableModelInvocation: boolean // If true, only user can invoke
  userInvocable: boolean // If true, user can invoke via slash command
  syncState: SkillSyncState
  isDirty: boolean // If true, local changes exist
  createdAt: Date
  updatedAt: Date
}

/**
 * SkillWithContent includes the full SKILL.md content
 */
export interface SkillWithContent extends Skill {
  content: string // Full SKILL.md content (markdown)
}

/**
 * SkillSyncState represents the sync status with a template
 */
export type SkillSyncState = 'detached' | 'synced' | 'outdated' | 'modified'

/**
 * Request types for API operations
 */
export interface CreateSkillRequest {
  name: string
  displayName: string
  description: string
  content?: string // Optional initial SKILL.md content
  disableModelInvocation?: boolean
  userInvocable?: boolean
}

export interface UpdateSkillRequest {
  displayName?: string
  description?: string
  content?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
}

export interface ReorderSkillsRequest {
  skillIds: string[]
}
