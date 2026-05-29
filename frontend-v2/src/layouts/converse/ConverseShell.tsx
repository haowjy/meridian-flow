import * as React from "react"
import { Article, SidebarSimple } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { FloatingScrollLayout } from "@/features/chat-scroll/FloatingScrollLayout"
import { TurnList } from "@/features/threads"
import { ChatComposer } from "@/features/threads/composer"
import { useThreadWsContext } from "@/features/threads/streaming/ThreadWsProvider"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useThreadStore } from "@/lib/thread-store"
import { subscribeToStream } from "@/lib/thread-store-streaming"

import { useShellActive } from "../app-shell/shell-visibility-context"
import { isLiveProjectId } from "../shared/data-mappers"
import { MOCK_EDITOR_SNIPPET } from "../shared/mock-data"
import { PaneWrapper } from "../shared/pane-wrapper"
import { ResizableSplit } from "../shared/resizable-split"
import { useShellThreadTurns } from "../shared/use-shell-thread-turns"
import { useThread } from "@/lib/queries"

type ConverseShellProps = {
  projectId?: string
  threadId?: string
  threadTitle?: string
  className?: string
}

function EditorPlaceholder({ title }: { title: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Article size={16} className="shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="truncate text-sm font-medium italic">{title}</h2>
        <span className="text-xs text-muted-foreground">Preview</span>
      </header>
      <div className="flex-1 overflow-y-auto p-4 font-editor text-sm leading-relaxed whitespace-pre-wrap text-foreground">
        {MOCK_EDITOR_SNIPPET}
      </div>
    </div>
  )
}

/**
 * Hook that bridges the ConverseShell to the thread store for live projects.
 * Handles loading turns, sending messages, and streaming.
 */
function useConverseThread(projectId: string | undefined, threadId: string | undefined) {
  const liveProject = isLiveProjectId(projectId)
  const isNewThread = threadId === "new"

  // Access streaming client from WS provider (may not exist in demo mode)
  let streamingClient: ReturnType<typeof useThreadWsContext>["streaming"] | null = null
  try {
    const ctx = useThreadWsContext()
    streamingClient = ctx.streaming
  } catch {
    // Outside ThreadWsProvider — demo mode
  }

  // Store state
  const storeTurnIds = useThreadStore((s) => s.turnIds)
  const storeTurnById = useThreadStore((s) => s.turnById)
  const storeIsStreaming = useThreadStore((s) => s.isStreaming)
  const storeThreadId = useThreadStore((s) => s.threadId)
  const storeLoadStatus = useThreadStore((s) => s.loadStatus)
  const storeError = useThreadStore((s) => s.error)

  // Load thread turns when threadId changes
  React.useEffect(() => {
    if (!liveProject || !threadId || isNewThread) return
    if (storeThreadId === threadId) return // Already loaded

    useThreadStore.getState().loadThread(threadId)
  }, [liveProject, threadId, isNewThread, storeThreadId])

  // Derive turns array from store
  const turns = React.useMemo(() => {
    if (!liveProject) return null // Will use mock data
    return storeTurnIds
      .map((id) => storeTurnById[id])
      .filter(Boolean)
  }, [liveProject, storeTurnIds, storeTurnById])

  const handleSubmit = React.useCallback(
    async (text: string) => {
      if (!liveProject || !projectId) return

      try {
        const result = await useThreadStore.getState().sendMessage(text, {
          projectId,
          threadId: isNewThread ? undefined : threadId,
        })

        // Subscribe to the assistant turn's stream
        if (streamingClient) {
          subscribeToStream(streamingClient, result.assistantTurnId)
        }
      } catch {
        // Error is set in the store
      }
    },
    [liveProject, projectId, threadId, isNewThread, streamingClient],
  )

  const handleStop = React.useCallback(() => {
    void useThreadStore.getState().interruptStream()
  }, [])

  // Show toast on errors
  React.useEffect(() => {
    if (storeError) {
      toast.error(storeError)
      useThreadStore.getState().clearError()
    }
  }, [storeError])

  return {
    turns,
    isStreaming: liveProject ? storeIsStreaming : false,
    isLoading: storeLoadStatus === "loading",
    error: storeError,
    handleSubmit,
    handleStop,
    isLive: liveProject,
  }
}

function ConverseShell({
  projectId,
  threadId,
  threadTitle = "Chapter 19 pacing revision",
  className,
}: ConverseShellProps) {
  const isActive = useShellActive("converse")
  const [editorOpen, setEditorOpen] = React.useState(true)
  const liveProject = isLiveProjectId(projectId)
  const threadQuery = useThread(threadId, {
    enabled: liveProject && Boolean(threadId) && threadId !== "new",
  })

  // Live thread data from store
  const converse = useConverseThread(projectId, threadId)

  // Mock fallback for demo mode
  const { turns: mockTurns } = useShellThreadTurns(projectId, threadId)

  const displayTitle =
    liveProject && threadQuery.data?.title ? threadQuery.data.title : threadTitle

  // Use store turns for live, mock for demo
  const displayTurns = converse.isLive ? (converse.turns ?? []) : mockTurns

  const threadPane = (
    <PaneWrapper className="h-full">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{displayTitle}</h1>
          <p className="text-xs text-muted-foreground">Converse thread</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={editorOpen ? "Hide editor pane" : "Show editor pane"}
          aria-pressed={editorOpen}
          onClick={() => setEditorOpen((open) => !open)}
        >
          <SidebarSimple size={18} />
        </Button>
      </header>
      <FloatingScrollLayout
        className="min-h-0 flex-1"
        autoScrollToBottom={converse.isStreaming}
        isStreaming={converse.isStreaming}
        bottomSlot={
          <div className="pointer-events-none px-4 pb-4 pt-6">
            <div className="pointer-events-auto mx-auto w-full max-w-3xl">
              <ChatComposer
                onSubmit={converse.isLive ? converse.handleSubmit : (text) => {
                  console.log("[ConverseShell] demo submit", text)
                }}
                isStreaming={converse.isStreaming}
                onStop={converse.handleStop}
              />
            </div>
          </div>
        }
      >
        <div className="px-4 py-4 cv-auto">
          <TurnList
            turns={displayTurns}
            onSwitchSibling={converse.isLive ? (targetTurnId) => {
              void useThreadStore.getState().switchSibling(targetTurnId)
            } : undefined}
            onEditTurn={converse.isLive ? (turnId) => {
              // For now, prompt-based edit. A proper inline edit UI comes later.
              const turn = useThreadStore.getState().turnById[turnId]
              if (!turn || turn.role !== "user") return
              const text = turn.blocks
                .filter((b) => b.blockType === "text")
                .map((b) => b.textContent ?? "")
                .join("")
              const newText = window.prompt("Edit message:", text)
              if (newText && newText !== text) {
                void useThreadStore.getState().editTurn(turnId, newText)
              }
            } : undefined}
            onRegenerateTurn={converse.isLive ? (turnId) => {
              void useThreadStore.getState().regenerateTurn(turnId)
            } : undefined}
          />
        </div>
      </FloatingScrollLayout>
    </PaneWrapper>
  )

  const editorPane = editorOpen ? (
    <EditorPlaceholder title="manuscript.md" />
  ) : null

  return (
    <div
      data-slot="converse-shell"
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
      data-shell-active={isActive || undefined}
    >
      <div className="hidden min-h-0 flex-1 tablet:flex">
        {editorOpen ? (
          <ResizableSplit
            storageKey="converse"
            defaultPrimarySize={420}
            minPrimary={320}
            maxPrimary={720}
            enabled
            primary={threadPane}
            secondary={editorPane}
          />
        ) : (
          threadPane
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col tablet:hidden">
        {threadPane}
      </div>
    </div>
  )
}

export { ConverseShell, type ConverseShellProps }
