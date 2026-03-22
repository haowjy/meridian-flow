export type ToolStatus = "pending" | "running" | "done" | "error"

export type EditReviewStatus = "pending-review" | "accepted" | "rejected"

export type ThinkingItem = {
  kind: "thinking"
  id: string
  text: string
}

export type DiffLine = {
  type: "context" | "add" | "remove"
  text: string
}

export type ReadToolDetail = {
  kind: "read"
  filePath: string
  previewLines?: string[]
}

export type EditToolDetail = {
  kind: "edit"
  filePath: string
  reviewStatus?: EditReviewStatus
  addedLines?: number
  removedLines?: number
  hunks?: number
  diffLines: DiffLine[]
  onAccept?: () => void
  onReject?: () => void
  onReviewInEditor?: () => void
}

export type DocSearchMatch = {
  id: string
  filePath: string
  lineStart: number
  lineEnd?: number
  snippet: string
}

export type DocSearchToolDetail = {
  kind: "doc-search"
  query: string
  matchCount: number
  matches: DocSearchMatch[]
}

export type WebSearchResult = {
  id: string
  title: string
  url: string
  snippet: string
}

export type WebSearchToolDetail = {
  kind: "web-search"
  query: string
  resultCount: number
  results: WebSearchResult[]
}

export type BashToolDetail = {
  kind: "bash"
  command: string
  output: string
  exitCode?: number
}

export type AgentActivity = {
  id: string
  name: string
  activity: ActivityBlockData
  response?: string
}

export type AgentToolDetail = {
  kind: "agent"
  agent: AgentActivity
}

export type ToolDetailData =
  | ReadToolDetail
  | EditToolDetail
  | DocSearchToolDetail
  | WebSearchToolDetail
  | BashToolDetail
  | AgentToolDetail

export type ToolItem = {
  kind: "tool"
  id: string
  toolName: string
  args?: Record<string, unknown>
  status: ToolStatus
  detail?: ToolDetailData
}

export type TextItem = {
  kind: "text"
  id: string
  text: string
}

export type ActivityItem = ThinkingItem | TextItem | ToolItem

export type ActivityBlockData = {
  id: string
  items: ActivityItem[]
  pendingText?: string
  isStreaming?: boolean
}
