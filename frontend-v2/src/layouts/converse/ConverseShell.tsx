import * as React from "react"
import { Article, SidebarSimple } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { FloatingScrollLayout } from "@/features/chat-scroll/FloatingScrollLayout"
import { TurnList } from "@/features/threads"
import { ChatComposer } from "@/features/threads/composer"
import { cn } from "@/lib/utils"
import { useChatThread } from "@/lib/use-chat-thread"

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
    <div className="bg-card flex h-full min-h-0 flex-col">
      <header className="border-border flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Article size={16} className="text-muted-foreground shrink-0" aria-hidden />
        <h2 className="truncate text-sm font-medium italic">{title}</h2>
        <span className="text-muted-foreground text-xs">Preview</span>
      </header>
      <div className="font-editor text-foreground flex-1 overflow-y-auto p-4 text-sm leading-relaxed whitespace-pre-wrap">
        {MOCK_EDITOR_SNIPPET}
      </div>
    </div>
  )
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

  // Live thread data from per-instance store
  const chat = useChatThread(projectId, threadId)

  // Mock fallback for demo mode only — live projects use the thread store
  const { turns: mockTurns } = useShellThreadTurns(
    liveProject ? undefined : projectId,
    liveProject ? undefined : threadId,
  )

  const displayTitle =
    liveProject && threadQuery.data?.title ? threadQuery.data.title : threadTitle

  // Use store turns for live, mock for demo
  const displayTurns = chat.isLive ? (chat.turns ?? []) : mockTurns

  const threadPane = (
    <PaneWrapper className="h-full">
      <header className="border-border flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{displayTitle}</h1>
          <p className="text-muted-foreground text-xs">Converse thread</p>
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
        autoScrollToBottom={chat.isStreaming}
        isStreaming={chat.isStreaming}
        bottomSlot={
          <div className="pointer-events-none px-4 pt-6 pb-4">
            <div className="pointer-events-auto mx-auto w-full max-w-3xl">
              <ChatComposer
                onSubmit={chat.isLive ? (text) => void chat.send(text) : (text) => {
                  console.log("[ConverseShell] demo submit", text)
                }}
                isStreaming={chat.isStreaming}
                onStop={chat.stop}
                onInterjection={chat.isLive ? chat.interject : undefined}
              />
            </div>
          </div>
        }
      >
        <div className="cv-auto px-4 py-4">
          <TurnList
            turns={displayTurns}
            onSwitchSibling={chat.isLive ? chat.switchSibling : undefined}
            onEditTurn={chat.isLive ? (turnId) => {
              // For now, prompt-based edit. A proper inline edit UI comes later.
              const turn = chat.store.getState().turnById[turnId]
              if (!turn || turn.role !== "user") return
              const text = turn.blocks
                .filter((b) => b.blockType === "text")
                .map((b) => b.textContent ?? "")
                .join("")
              const newText = window.prompt("Edit message:", text)
              if (newText && newText !== text) {
                chat.editTurn(turnId, newText)
              }
            } : undefined}
            onRegenerateTurn={chat.isLive ? chat.regenerateTurn : undefined}
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
      <div className="tablet:flex hidden min-h-0 flex-1">
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

      <div className="tablet:hidden flex min-h-0 flex-1 flex-col">
        {threadPane}
      </div>
    </div>
  )
}

export { ConverseShell, type ConverseShellProps }
