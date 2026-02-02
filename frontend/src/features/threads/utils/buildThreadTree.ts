import type { Thread } from '@/features/threads/types'

export type ThreadNodeType = 'root' | 'branch' | 'subagent'

/**
 * View model for rendering threads as a tree.
 *
 * NOTE: This is intentionally NOT `extends Thread` to keep UI concerns separate
 * from the API/domain model. When backend fields like `parentThreadId` arrive,
 * we can update only the builder without forcing UI refactors.
 */
export interface ThreadNode {
  thread: Thread
  children: ThreadNode[]
  level: number
  nodeType: ThreadNodeType
}

/**
 * Current behavior: treat the flat list as root-level nodes.
 * Future behavior: build a nested structure once the backend provides parent/session fields.
 */
export function buildThreadTree(threads: Thread[]): ThreadNode[] {
  return threads.map((thread) => ({
    thread,
    children: [],
    level: 0,
    nodeType: 'root',
  }))
}

