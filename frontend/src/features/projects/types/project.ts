export interface Project {
  id: string
  name: string
  /** URL-friendly identifier, unique per user */
  slug: string
  createdAt: Date
  updatedAt: Date
}
