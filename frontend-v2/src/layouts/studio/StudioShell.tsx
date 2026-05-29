import * as React from "react"
import { ChatTeardrop } from "@phosphor-icons/react"

import {
  FileExplorer,
  type FileExplorerState,
} from "@/components/ui/file-explorer"
import { TabBar, type TabBarTab } from "@/components/ui/tab-bar"
import { FloatingScrollLayout } from "@/features/chat-scroll/FloatingScrollLayout"
import { TurnList } from "@/features/threads"
import { ChatComposer } from "@/features/threads/composer"
import { StandaloneEditor } from "@/editor/stories/helpers/StandaloneEditor"
import { cn } from "@/lib/utils"
import { useThreadStore } from "@/lib/thread-store"
import { subscribeToStream } from "@/lib/thread-store-streaming"
import { useThreadWsContext } from "@/features/threads/streaming/ThreadWsProvider"

import { useShellActive } from "../app-shell/shell-visibility-context"
import {
  documentTreeToExplorerNodes,
  isLiveProjectId,
} from "../shared/data-mappers"
import {
  MOCK_EDITOR_SNIPPET,
  MOCK_FILE_TREE,
  MOCK_STUDIO_TABS,
} from "../shared/mock-data"
import { PaneWrapper } from "../shared/pane-wrapper"
import { ResizableSplit } from "../shared/resizable-split"
import { useShellThreadTurns } from "../shared/use-shell-thread-turns"
import { readPersistedTabs, writePersistedTabs } from "./tab-storage"
import { useDocumentTree, useThreads } from "@/lib/queries"

type StudioShellProps = {
  projectId?: string
  activeDocumentPath?: string
  className?: string
}

function StudioShell({
  projectId,
  activeDocumentPath = "manuscript.md",
  className,
}: StudioShellProps) {
  const isActive = useShellActive("studio")
  const liveProject = isLiveProjectId(projectId)

  // Streaming client for sidecar chat
  let streamingClient: ReturnType<typeof useThreadWsContext>["streaming"] | null = null
  try {
    const ctx = useThreadWsContext()
    streamingClient = ctx.streaming
  } catch { /* outside ThreadWsProvider */ }

  const storeIsStreaming = useThreadStore((s) => s.isStreaming)
  const treeQuery = useDocumentTree(projectId, { enabled: liveProject })
  const {
    isLoading: treeLoading,
    isError: treeError,
    data: treeData,
    refetch: refetchTree,
  } = treeQuery
  const threadsQuery = useThreads(projectId, { enabled: liveProject })
  const sidecarThreadId = threadsQuery.data?.[0]?.id
  const { turns: sidecarTurns } = useShellThreadTurns(projectId, sidecarThreadId)
  const stableProjectId = projectId ?? "demo"
  const [tabs, setTabs] = React.useState<TabBarTab[]>(() =>
    readPersistedTabs(stableProjectId, MOCK_STUDIO_TABS),
  )
  const [activeTabId, setActiveTabId] = React.useState(activeDocumentPath)
  const [activeFileId, setActiveFileId] = React.useState(activeDocumentPath)
  const explorerOpen = true

  React.useEffect(() => {
    setActiveTabId(activeDocumentPath)
    setActiveFileId(activeDocumentPath)
  }, [activeDocumentPath])

  // Persist tabs to localStorage on change (scoped by project)
  React.useEffect(() => {
    writePersistedTabs(stableProjectId, tabs)
  }, [stableProjectId, tabs])

  const handleTabClose = (tabId: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== tabId)
      if (activeTabId === tabId) {
        setActiveTabId(next[0]?.id ?? null)
      }
      return next
    })
  }

  const handleTabPromote = (tabId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId ? { ...tab, isPreview: false } : tab,
      ),
    )
  }

  const explorerData = React.useMemo((): {
    state: FileExplorerState
    nodes: typeof MOCK_FILE_TREE
    onRetry?: () => void
  } => {
    if (!liveProject) {
      return { state: "ready", nodes: MOCK_FILE_TREE }
    }
    if (treeLoading) {
      return { state: "loading", nodes: [] }
    }
    if (treeError) {
      return {
        state: "error",
        nodes: [],
        onRetry: () => {
          void refetchTree()
        },
      }
    }
    const nodes = documentTreeToExplorerNodes(treeData!)
    if (nodes.length === 0) {
      return { state: "empty", nodes: [] }
    }
    return { state: "ready", nodes }
  }, [liveProject, treeLoading, treeError, treeData, refetchTree])

  const editorArea = (
    <PaneWrapper className="h-full">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabActivate={setActiveTabId}
        onTabClose={handleTabClose}
        onTabPin={handleTabPromote}
        onTabPromote={handleTabPromote}
        showOverflowIndicator={tabs.length > 4}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <StandaloneEditor
          initialContent={MOCK_EDITOR_SNIPPET}
          livePreview
          className="h-full w-full max-w-none"
        />
      </div>
    </PaneWrapper>
  )

  const sidecar = (
    <PaneWrapper className="h-full border-l border-border" hideOnPhone>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <ChatTeardrop size={16} className="text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">Sidecar thread</h2>
          <p className="text-xs text-muted-foreground">Manual thread selection</p>
        </div>
      </header>
      <FloatingScrollLayout
        className="min-h-0 flex-1"
        autoScrollToBottom={false}
        isStreaming={false}
        bottomSlot={
          <div className="pointer-events-none px-3 pb-3 pt-4">
            <div className="pointer-events-auto">
              <ChatComposer
                placeholder="Discuss in sidecar…"
                isStreaming={liveProject ? storeIsStreaming : false}
                onSubmit={(text) => {
                  if (!liveProject || !projectId || !sidecarThreadId) {
                    console.log("[StudioShell] demo sidecar submit", text)
                    return
                  }
                  void (async () => {
                    try {
                      const result = await useThreadStore.getState().sendMessage(text, {
                        projectId,
                        threadId: sidecarThreadId,
                      })
                      if (streamingClient) {
                        subscribeToStream(streamingClient, result.assistantTurnId)
                      }
                    } catch { /* error in store */ }
                  })()
                }}
                onStop={() => {
                  void useThreadStore.getState().interruptStream()
                }}
              />
            </div>
          </div>
        }
      >
        <div className="px-3 py-3 cv-auto">
          <TurnList turns={sidecarTurns.slice(0, 3)} />
        </div>
      </FloatingScrollLayout>
    </PaneWrapper>
  )

  const explorer = explorerOpen ? (
    <PaneWrapper className="h-full w-full border-r border-border">
      <FileExplorer
        state={explorerData.state}
        nodes={explorerData.nodes}
        activeFileId={activeFileId}
        defaultExpandedIds={liveProject ? [] : ["chapters", "notes"]}
        onRetry={explorerData.onRetry}
        onFileSelect={(fileId) => {
          setActiveFileId(fileId)
          setActiveTabId(fileId)
          if (!tabs.some((tab) => tab.id === fileId)) {
            const label = fileId.split("/").pop() ?? fileId
            setTabs((current) => [...current, { id: fileId, label }])
          }
        }}
      />
    </PaneWrapper>
  ) : null

  const mainSplit = (
    <ResizableSplit
      storageKey="studio-editor-sidecar"
      defaultPrimarySize={520}
      minPrimary={360}
      maxPrimary={900}
      enabled
      primary={editorArea}
      secondary={sidecar}
    />
  )

  return (
    <div
      data-slot="studio-shell"
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
      data-shell-active={isActive || undefined}
    >
      <div className="hidden min-h-0 flex-1 nav-rail:flex">
        {explorerOpen ? (
          <div className="flex min-h-0 min-w-0 flex-1">
            <div className="w-52 shrink-0">{explorer}</div>
            <div className="min-h-0 min-w-0 flex-1">{mainSplit}</div>
          </div>
        ) : (
          mainSplit
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col nav-rail:hidden">
        {editorArea}
      </div>
    </div>
  )
}

export { StudioShell, type StudioShellProps }
