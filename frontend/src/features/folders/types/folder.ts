export interface Folder {
  id: string
  projectId: string
  parentId: string | null
  name: string
  createdAt: Date
}
