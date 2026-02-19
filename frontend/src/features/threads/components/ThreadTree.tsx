import { ThreadRow } from "./ThreadRow";
import type { Thread } from "@/features/threads/types";
import type { ThreadNode } from "../utils/buildThreadTree";

interface ThreadTreeProps {
  nodes: ThreadNode[];
  activeThreadId: string | null;
  isLoading: boolean;
  renamingThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onRename: (threadId: string) => void;
  onRenameSubmit: (threadId: string, newTitle: string) => void;
  onRenameCancel: () => void;
  onDelete: (thread: Thread) => void;
}

/**
 * Pure tree renderer for threads.
 *
 * Responsibilities:
 * - Layout and mapping nodes -> ThreadRow (recursive).
 * - No data fetching or side effects.
 */
export function ThreadTree({
  nodes,
  activeThreadId,
  isLoading,
  renamingThreadId,
  onSelectThread,
  onRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: ThreadTreeProps) {
  const renderNode = (node: ThreadNode) => (
    <div key={node.thread.id}>
      <ThreadRow
        thread={node.thread}
        level={node.level}
        nodeType={node.nodeType}
        hasChildren={node.children.length > 0}
        isActive={node.thread.id === activeThreadId}
        isDisabled={isLoading}
        isRenaming={node.thread.id === renamingThreadId}
        onClick={() => onSelectThread(node.thread.id)}
        onRename={() => onRename(node.thread.id)}
        onRenameSubmit={(newTitle) => onRenameSubmit(node.thread.id, newTitle)}
        onRenameCancel={onRenameCancel}
        onDelete={() => onDelete(node.thread)}
      />

      {node.children.length > 0 && node.children.map(renderNode)}
    </div>
  );

  return (
    <div className="space-y-0.5 px-2 pt-2 pb-2">{nodes.map(renderNode)}</div>
  );
}
