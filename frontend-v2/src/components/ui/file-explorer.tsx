import * as React from "react"
import {
  FileText,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Warning,
} from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  createTreeCollection,
  TreeViewBranch,
  TreeViewBranchContent,
  TreeViewBranchControl,
  TreeViewBranchIndentGuide,
  TreeViewBranchText,
  TreeViewItem,
  TreeViewItemText,
  TreeViewNodeProvider,
  TreeViewRoot,
  TreeViewTree,
  useTreeViewNodeContext,
} from "@/components/ui/tree-view"

export type FileExplorerNode = {
  id: string
  name: string
  children?: FileExplorerNode[]
}

export type FileExplorerState = "ready" | "loading" | "empty" | "error"

type FileExplorerProps = {
  state?: FileExplorerState
  nodes?: FileExplorerNode[]
  activeFileId?: string | null
  defaultExpandedIds?: string[]
  onFileSelect?: (fileId: string) => void
  onCreateDocument?: () => void
  onRetry?: () => void
  className?: string
}

function FolderIcon() {
  const nodeState = useTreeViewNodeContext()
  return nodeState.expanded ? (
    <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  ) : (
    <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  )
}

function ExplorerTreeNode({
  node,
  indexPath,
  activeFileId,
  onFileSelect,
}: {
  node: FileExplorerNode
  indexPath: number[]
  activeFileId?: string | null
  onFileSelect?: (fileId: string) => void
}) {
  const isActive = node.id === activeFileId

  return (
    <TreeViewNodeProvider node={node} indexPath={indexPath}>
      {node.children ? (
        <TreeViewBranch>
          <TreeViewBranchControl
            className={cn(
              "h-7 rounded-none px-2 hover:bg-muted",
              isActive && "bg-accent-fill/10 font-medium text-accent-text",
            )}
          >
            <FolderIcon />
            <TreeViewBranchText>{node.name}</TreeViewBranchText>
          </TreeViewBranchControl>
          <TreeViewBranchContent>
            <TreeViewBranchIndentGuide />
            {node.children.map((child, i) => (
              <ExplorerTreeNode
                key={child.id}
                node={child}
                indexPath={[...indexPath, i]}
                activeFileId={activeFileId}
                onFileSelect={onFileSelect}
              />
            ))}
          </TreeViewBranchContent>
        </TreeViewBranch>
      ) : (
        <TreeViewItem
          className={cn(
            "h-7 rounded-none px-2 hover:bg-muted",
            isActive && "bg-accent-fill/10 font-medium text-accent-text",
          )}
          onClick={() => onFileSelect?.(node.id)}
        >
          <TreeViewItemText>
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            {node.name}
          </TreeViewItemText>
        </TreeViewItem>
      )}
    </TreeViewNodeProvider>
  )
}

function FileExplorerLoading() {
  return (
    <div data-slot="file-explorer-loading" className="space-y-2 p-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  )
}

function FileExplorerEmpty({ onCreateDocument }: { onCreateDocument?: () => void }) {
  return (
    <div
      data-slot="file-explorer-empty"
      className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center"
    >
      <FolderPlus className="size-8 text-muted-foreground" aria-hidden />
      <div>
        <p className="text-base text-foreground">No documents</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a document to start writing in Studio.
        </p>
      </div>
      {onCreateDocument ? (
        <Button type="button" size="sm" onClick={onCreateDocument}>
          <FilePlus className="size-4" />
          Create document
        </Button>
      ) : null}
    </div>
  )
}

function FileExplorerError({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      data-slot="file-explorer-error"
      className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center"
    >
      <Warning className="size-8 text-destructive" aria-hidden />
      <div>
        <p className="text-base text-foreground">Could not load documents</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Check your connection and try again.
        </p>
      </div>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  )
}

function FileExplorer({
  state = "ready",
  nodes = [],
  activeFileId,
  defaultExpandedIds = [],
  onFileSelect,
  onCreateDocument,
  onRetry,
  className,
}: FileExplorerProps) {
  const collection = React.useMemo(
    () =>
      createTreeCollection<FileExplorerNode>({
        nodeToValue: (node) => node.id,
        nodeToString: (node) => node.name,
        rootNode: { id: "ROOT", name: "", children: nodes },
      }),
    [nodes],
  )

  return (
    <aside
      data-slot="file-explorer"
      aria-label="Documents"
      className={cn(
        "flex h-full w-48 min-w-36 max-w-72 flex-col border-r border-sidebar-border bg-sidebar text-sm",
        className,
      )}
    >
      {state === "loading" ? (
        <FileExplorerLoading />
      ) : state === "empty" ? (
        <FileExplorerEmpty onCreateDocument={onCreateDocument} />
      ) : state === "error" ? (
        <FileExplorerError onRetry={onRetry} />
      ) : (
        <TreeViewRoot
          collection={collection}
          defaultExpandedValue={defaultExpandedIds}
          className="min-h-0 flex-1 overflow-y-auto p-1"
        >
          <TreeViewTree>
            {nodes.map((node, index) => (
              <ExplorerTreeNode
                key={node.id}
                node={node}
                indexPath={[index]}
                activeFileId={activeFileId}
                onFileSelect={onFileSelect}
              />
            ))}
          </TreeViewTree>
        </TreeViewRoot>
      )}
    </aside>
  )
}

export { FileExplorer, type FileExplorerProps }
