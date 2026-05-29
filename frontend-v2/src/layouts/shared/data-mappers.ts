import type { FileExplorerNode } from "@/components/ui/file-explorer"
import type { WorkItemStatus } from "@/components/ui/work-item-card"
import type { Thread } from "@/features/threads/types"
import type { DocumentTree, TreeDocumentNode, TreeFolderNode } from "@/lib/api/types"

import { DEMO_PROJECT_ID } from "./mock-data"

/** Phase 4b: skip REST for the Storybook/demo project id. */
export function isLiveProjectId(projectId: string | undefined): boolean {
  return Boolean(projectId) && projectId !== DEMO_PROJECT_ID
}

function documentToExplorerNode(doc: TreeDocumentNode): FileExplorerNode {
  return {
    id: doc.path,
    name: doc.name,
  }
}

function folderToExplorerNode(folder: TreeFolderNode): FileExplorerNode {
  return {
    id: folder.id,
    name: folder.name,
    children: [
      ...folder.folders.map(folderToExplorerNode),
      ...folder.documents.map(documentToExplorerNode),
    ],
  }
}

export function documentTreeToExplorerNodes(tree: DocumentTree): FileExplorerNode[] {
  return [
    ...tree.folders.map(folderToExplorerNode),
    ...tree.documents.map(documentToExplorerNode),
  ]
}

export function formatRelativeActivity(date: Date): string {
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const abs = Math.abs(seconds)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

  if (abs < 60) return rtf.format(seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour")
  const days = Math.round(hours / 24)
  return rtf.format(days, "day")
}

export type ShellWorkItem = {
  id: string
  title: string
  status: WorkItemStatus
  threadCount: number
  lastActivity: string
  threadId: string
}

export function threadsToWorkItems(threads: Thread[]): ShellWorkItem[] {
  return threads.map((thread, index) => ({
    id: thread.id,
    title: thread.title,
    status: index === 0 ? "active" : "idle",
    threadCount: 1,
    lastActivity: formatRelativeActivity(thread.createdAt),
    threadId: thread.id,
  }))
}
