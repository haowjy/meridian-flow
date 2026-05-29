import * as React from "react"
import { ArrowLeft, ChatTeardrop, List } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { WorkItemCard } from "@/components/ui/work-item-card"
import { FloatingScrollLayout } from "@/features/chat-scroll/FloatingScrollLayout"
import { TurnList } from "@/features/threads"
import { ChatComposer } from "@/features/threads/composer"
import { cn } from "@/lib/utils"
import { useThreadStore } from "@/lib/thread-store"
import { subscribeToStream } from "@/lib/thread-store-streaming"
import { useThreadWsContext } from "@/features/threads/streaming/ThreadWsProvider"

import { useShellActive } from "../app-shell/shell-visibility-context"
import {
  isLiveProjectId,
  threadsToWorkItems,
  type ShellWorkItem,
} from "../shared/data-mappers"
import { MOCK_SESSION, MOCK_WORK_ITEMS } from "../shared/mock-data"
import { PaneWrapper } from "../shared/pane-wrapper"
import { ResizableSplit } from "../shared/resizable-split"
import { useShellThreadTurns } from "../shared/use-shell-thread-turns"
import { useThreads } from "@/lib/queries"

type AgentsShellProps = {
  projectId?: string
  onOpenInConverse?: (threadId: string) => void
  className?: string
}

function AgentsShell({ projectId, onOpenInConverse, className }: AgentsShellProps) {
  const isActive = useShellActive("agents")
  const liveProject = isLiveProjectId(projectId)
  const threadsQuery = useThreads(projectId, { enabled: liveProject })

  // Get streaming client at hook level (safe — null if outside provider)
  let streamingClient: ReturnType<typeof useThreadWsContext>["streaming"] | null = null
  try {
    const ctx = useThreadWsContext()
    streamingClient = ctx.streaming
  } catch { /* outside ThreadWsProvider */ }

  const storeIsStreaming = useThreadStore((s) => s.isStreaming)

  const workItems: ShellWorkItem[] = React.useMemo(() => {
    if (!liveProject) return MOCK_WORK_ITEMS
    if (threadsQuery.isError) return MOCK_WORK_ITEMS
    if (threadsQuery.isSuccess) {
      return threadsQuery.data.length > 0
        ? threadsToWorkItems(threadsQuery.data)
        : []
    }
    return MOCK_WORK_ITEMS
  }, [
    liveProject,
    threadsQuery.isError,
    threadsQuery.isSuccess,
    threadsQuery.data,
  ])

  const [selectedId, setSelectedId] = React.useState(workItems[0]?.id ?? "")
  const [showDetailOnPhone, setShowDetailOnPhone] = React.useState(false)

  React.useEffect(() => {
    if (!workItems.some((item) => item.id === selectedId)) {
      setSelectedId(workItems[0]?.id ?? "")
    }
  }, [workItems, selectedId])

  const selectedItem =
    workItems.find((item) => item.id === selectedId) ?? workItems[0]

  const { turns: detailTurns } = useShellThreadTurns(
    projectId,
    selectedItem?.threadId,
  )

  const dashboard = (
    <PaneWrapper className="h-full border-r border-border">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{MOCK_SESSION.title}</h1>
          <p className="text-xs text-muted-foreground">Session dashboard</p>
        </div>
        <Badge variant="success">Active</Badge>
      </header>
      <div className="flex-1 overflow-y-auto p-3 cv-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
          {workItems.map((item) => (
            <WorkItemCard
              key={item.id}
              title={item.title}
              status={item.status}
              threadCount={item.threadCount}
              lastActivity={item.lastActivity}
              selected={item.id === selectedId}
              onClick={() => {
                setSelectedId(item.id)
                setShowDetailOnPhone(true)
              }}
            />
          ))}
        </div>
      </div>
    </PaneWrapper>
  )

  const detail = (
    <PaneWrapper className="h-full">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="tablet:hidden"
          aria-label="Back to dashboard"
          onClick={() => setShowDetailOnPhone(false)}
        >
          <ArrowLeft size={18} />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{selectedItem?.title}</h2>
          <p className="text-xs text-muted-foreground">Thread detail</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="hidden tablet:inline-flex"
          onClick={() => selectedItem && onOpenInConverse?.(selectedItem.threadId)}
        >
          <ChatTeardrop size={16} className="mr-1.5" />
          Open in Converse
        </Button>
      </header>
      <FloatingScrollLayout
        className="min-h-0 flex-1"
        autoScrollToBottom={false}
        isStreaming={false}
        bottomSlot={
          <div className="pointer-events-none px-4 pb-4 pt-6">
            <div className="pointer-events-auto mx-auto w-full max-w-3xl">
              <ChatComposer
                placeholder="Reply in session context…"
                isStreaming={liveProject ? storeIsStreaming : false}
                onSubmit={(text) => {
                  if (!liveProject || !projectId || !selectedItem?.threadId) {
                    console.log("[AgentsShell] demo submit", text)
                    return
                  }
                  void (async () => {
                    try {
                      const result = await useThreadStore.getState().sendMessage(text, {
                        projectId,
                        threadId: selectedItem.threadId,
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
        <div className="px-4 py-4 cv-auto">
          <TurnList turns={detailTurns.slice(0, 4)} />
        </div>
      </FloatingScrollLayout>
    </PaneWrapper>
  )

  return (
    <div
      data-slot="agents-shell"
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
      data-shell-active={isActive || undefined}
    >
      <div className="hidden min-h-0 flex-1 nav-rail:flex">
        <ResizableSplit
          storageKey="agents"
          defaultPrimarySize={360}
          minPrimary={280}
          maxPrimary={560}
          enabled
          primary={dashboard}
          secondary={detail}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col nav-rail:hidden">
        {showDetailOnPhone ? (
          detail
        ) : (
          <>
            {dashboard}
            <div className="border-t border-border p-2 tablet:hidden">
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={!selectedItem}
                onClick={() => setShowDetailOnPhone(true)}
              >
                <List size={16} className="mr-2" />
                View thread detail
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export { AgentsShell, type AgentsShellProps }
