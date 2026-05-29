import { THREAD_WALKTHROUGH } from "@/features/activity-stream/examples"
import type { FileExplorerNode } from "@/components/ui/file-explorer"
import type { TabBarTab } from "@/components/ui/tab-bar"
import type { WorkItemStatus } from "@/components/ui/work-item-card"
import type { ThreadTurn } from "@/features/threads"

export const DEMO_PROJECT_ID = "demo"
export const DEMO_THREAD_ID = "demo-thread"
export const DEMO_DOCUMENT_PATH = "manuscript.md"

export const MOCK_FILE_TREE: FileExplorerNode[] = [
  {
    id: "chapters",
    name: "chapters",
    children: [
      { id: "chapters/28.md", name: "28-lantern-harbor.md" },
      { id: "chapters/29.md", name: "29-tideglass-gate.md" },
      { id: "chapters/30.md", name: "30-oath-ledger.md" },
    ],
  },
  {
    id: "notes",
    name: "notes",
    children: [
      { id: "notes/outline.md", name: "arc-4-outline.md" },
      { id: "notes/characters.md", name: "characters.md" },
    ],
  },
  { id: "manuscript.md", name: "manuscript.md" },
  { id: "README.md", name: "README.md" },
]

export const MOCK_STUDIO_TABS: TabBarTab[] = [
  { id: "manuscript.md", label: "manuscript.md" },
  { id: "chapters/28.md", label: "28-lantern-harbor.md", isDirty: true },
  { id: "notes/outline.md", label: "arc-4-outline.md", isPreview: true },
]

export type MockWorkItem = {
  id: string
  title: string
  status: WorkItemStatus
  threadCount: number
  lastActivity: string
  threadId: string
}

export const MOCK_WORK_ITEMS: MockWorkItem[] = [
  {
    id: "wi-pacing",
    title: "Chapter 19 pacing revision",
    status: "active",
    threadCount: 3,
    lastActivity: "2m ago",
    threadId: DEMO_THREAD_ID,
  },
  {
    id: "wi-outline",
    title: "Arc 4 outline review",
    status: "idle",
    threadCount: 1,
    lastActivity: "1h ago",
    threadId: "thread-outline",
  },
  {
    id: "wi-characters",
    title: "Character sheet sync",
    status: "completed",
    threadCount: 2,
    lastActivity: "Yesterday",
    threadId: "thread-characters",
  },
]

export const MOCK_THREAD_TURNS: ThreadTurn[] = THREAD_WALKTHROUGH.history

export const MOCK_SESSION = {
  id: "session-demo",
  title: "Lantern Harbor — Arc 4",
  status: "active" as const,
}

export const MOCK_EDITOR_SNIPPET = `# Lantern Harbor

Elara reached the harbor before dawn. The tide had not yet turned, and the
pilings wore a skin of salt that caught the first gray light.

She opened **manuscript.md** and found the paragraph that still refused to
settle — the transition into the bell-strike scene.`
