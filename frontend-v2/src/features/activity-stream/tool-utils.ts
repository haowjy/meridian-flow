import {
  BookOpen,
  Globe,
  MagnifyingGlass,
  PencilSimple,
  Terminal,
  UserCircle,
} from "@phosphor-icons/react"

import type { BadgeProps } from "@/components/ui/badge"

import type { ActivityItem, ToolItem, ToolStatus } from "./types"

export type ToolCategory = "read" | "edit" | "doc-search" | "web-search" | "bash" | "agent" | "other"

export const STREAMING_STATUS_MESSAGES = [
  "Turning pages...",
  "Consulting the muse...",
  "Reading between the lines...",
  "Sharpening the quill...",
  "Pondering the plot...",
  "Checking the manuscript...",
  "Weighing the words...",
  "Following the thread...",
]

function hasAny(fragment: string, candidates: string[]) {
  return candidates.some((candidate) => fragment.includes(candidate))
}

export function getToolCategory(tool: ToolItem | string): ToolCategory {
  if (typeof tool !== "string" && tool.detail) {
    if (tool.detail.kind === "read") {
      return "read"
    }

    if (tool.detail.kind === "edit") {
      return "edit"
    }

    if (tool.detail.kind === "doc-search") {
      return "doc-search"
    }

    if (tool.detail.kind === "web-search") {
      return "web-search"
    }

    if (tool.detail.kind === "bash") {
      return "bash"
    }

    if (tool.detail.kind === "agent") {
      return "agent"
    }
  }

  const normalized = (typeof tool === "string" ? tool : tool.toolName).trim().toLowerCase()

  if (hasAny(normalized, ["read", "view", "open"])) {
    return "read"
  }

  if (hasAny(normalized, ["edit", "write", "replace", "patch", "str_replace"])) {
    return "edit"
  }

  if (hasAny(normalized, ["web_search", "web-search"])) {
    return "web-search"
  }

  if (hasAny(normalized, ["search", "grep", "glob", "find", "doc_search"])) {
    return "doc-search"
  }

  if (hasAny(normalized, ["bash", "terminal", "command", "exec", "execute", "code"])) {
    return "bash"
  }

  if (hasAny(normalized, ["agent", "spawn", "delegate", "thread"])) {
    return "agent"
  }

  return "other"
}

export function getToolIcon(category: ToolCategory) {
  if (category === "read") {
    return BookOpen
  }

  if (category === "edit") {
    return PencilSimple
  }

  if (category === "doc-search") {
    return MagnifyingGlass
  }

  if (category === "web-search") {
    return Globe
  }

  if (category === "bash" || category === "other") {
    return Terminal
  }

  return UserCircle
}

function pluralize(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural
}

export function getActivitySummary(items: ActivityItem[]) {
  const counts: Record<ToolCategory, number> = {
    "read": 0,
    "edit": 0,
    "doc-search": 0,
    "web-search": 0,
    "bash": 0,
    "agent": 0,
    "other": 0,
  }

  for (const item of items) {
    if (item.kind !== "tool") {
      continue
    }

    counts[getToolCategory(item)] += 1
  }

  const parts: string[] = []

  if (counts.read > 0) {
    parts.push(`read ${counts.read} ${pluralize(counts.read, "file", "files")}`)
  }

  if (counts.edit > 0) {
    parts.push(`edited ${counts.edit}`)
  }

  if (counts["doc-search"] > 0) {
    parts.push(`searched ${counts["doc-search"]}`)
  }

  if (counts["web-search"] > 0) {
    parts.push(`web searched ${counts["web-search"]}`)
  }

  if (counts.bash > 0) {
    parts.push(`ran ${counts.bash} ${pluralize(counts.bash, "command", "commands")}`)
  }

  if (counts.agent > 0) {
    parts.push(`spawned ${counts.agent} ${pluralize(counts.agent, "agent", "agents")}`)
  }

  if (parts.length === 0) {
    return "thinking..."
  }

  return parts.join(", ")
}

export function trimPath(pathValue: string) {
  const segments = pathValue.split("/")
  return segments.at(-1) ?? pathValue
}

function readStringValue(input: Record<string, unknown> | undefined, keys: string[]) {
  if (!input) {
    return undefined
  }

  for (const key of keys) {
    const value = input[key]

    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }

  return undefined
}

export function getToolArgumentSummary(tool: ToolItem) {
  if (tool.detail?.kind === "read") {
    return trimPath(tool.detail.filePath)
  }

  if (tool.detail?.kind === "edit") {
    return trimPath(tool.detail.filePath)
  }

  if (tool.detail?.kind === "doc-search") {
    return `"${tool.detail.query}"`
  }

  if (tool.detail?.kind === "web-search") {
    return `"${tool.detail.query}"`
  }

  if (tool.detail?.kind === "bash") {
    return tool.detail.command
  }

  if (tool.detail?.kind === "agent") {
    return tool.detail.agent.name
  }

  const argValue = readStringValue(tool.args, [
    "path",
    "file",
    "filePath",
    "target",
    "query",
    "command",
    "description",
    "name",
  ])

  if (!argValue) {
    return undefined
  }

  const category = getToolCategory(tool)
  if (category === "read" || category === "edit") {
    return trimPath(argValue)
  }

  return argValue
}

function getToolActionLabel(category: ToolCategory) {
  if (category === "read") {
    return "Read"
  }

  if (category === "edit") {
    return "Edit"
  }

  if (category === "doc-search") {
    return "Search"
  }

  if (category === "web-search") {
    return "Web"
  }

  if (category === "bash") {
    return "Bash"
  }

  if (category === "agent") {
    return "Agent"
  }

  return "Tool"
}

export function getToolLineTitle(tool: ToolItem) {
  const category = getToolCategory(tool)
  const summary = getToolArgumentSummary(tool)
  const label = getToolActionLabel(category)

  if (!summary) {
    return label
  }

  return `${label}(${summary})`
}

export function getToolStatusLabel(status: ToolStatus) {
  if (status === "done") {
    return "ok"
  }

  if (status === "error") {
    return "error"
  }

  if (status === "running") {
    return "running"
  }

  return "pending"
}

export function getToolStatusVariant(status: ToolStatus): BadgeProps["variant"] {
  if (status === "done") {
    return "success"
  }

  if (status === "error") {
    return "destructive"
  }

  if (status === "running") {
    return "secondary"
  }

  return "outline"
}
