import * as React from "react"
import { ArrowLeft, ChatTeardrop, List } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { WorkItemCard } from "@/components/ui/work-item-card"
import { FloatingScrollLayout } from "@/features/chat-scroll/FloatingScrollLayout"
import { TurnList } from "@/features/threads"
import { ChatComposer } from "@/features/threads/composer"
import { cn } from "@/lib/utils"
import { useChatThread } from "@/lib/use-chat-thread"

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

  // Per-instance chat thread for the detail panel
  const chat = useChatThread(projectId, selectedItem?.threadId)

  // Use chat store turns for live display, mock fallback for demo
  const { turns: mockDetailTurns } = useShellThreadTurns(
    liveProject ? undefined : projectId,
    liveProject ? undefined : selectedItem?.threadId,
  )
  const detailTurns = chat.isLive ? (chat.turns ?? []) : mockDetailTurns

  const dashboard = (
    <PaneWrapper className="h-full">
      <header className="border-border/40 flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{MOCK_SESSION.title}</h1>
        </div>
        <Badge variant="success">Active</Badge>
      </header>
      <div className="cv-auto flex-1 overflow-y-auto p-3">
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
      <header className="border-border/40 flex shrink-0 items-center gap-2 border-b px-3 py-2">
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
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="tablet:inline-flex hidden"
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
          <div className="from-background pointer-events-none bg-gradient-to-t from-80% to-transparent px-4 pt-8 pb-4">
            <div className="pointer-events-auto mx-auto w-full max-w-3xl">
              <ChatComposer
                placeholder="Reply in session context…"
                isStreaming={chat.isStreaming}
                onSubmit={(text) => {
                  if (!chat.isLive) {
                    console.log("[AgentsShell] demo submit", text)
                    return
                  }
                  void chat.send(text)
                }}
                onStop={chat.stop}
              />
            </div>
          </div>
        }
      >
        <div className="cv-auto px-4 py-4">
          <TurnList turns={detailTurns} />
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
      <div className="nav-rail:flex hidden min-h-0 flex-1">
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

      <div className="nav-rail:hidden flex min-h-0 flex-1 flex-col">
        {showDetailOnPhone ? (
          detail
        ) : (
          <>
            {dashboard}
            <div className="border-border/40 tablet:hidden border-t p-2">
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
