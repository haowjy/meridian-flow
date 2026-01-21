export interface Project {
  id: string
  name: string
  /** URL-friendly identifier, unique per user */
  slug: string
  /** Whether the project is marked as a favorite for quick access */
  isFavorite: boolean
  /** Last content activity timestamp (documents, folders, threads) */
  lastActivityAt: Date
  createdAt: Date
  updatedAt: Date
}
