import * as React from "react"
import { Article, SidebarSimple } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { FloatingScrollLayout } from "@/features/chat-scroll/FloatingScrollLayout"
import { TurnList } from "@/features/threads"
import { ChatComposer } from "@/features/threads/composer"
import { cn } from "@/lib/utils"

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
    enabled: liveProject && Boolean(threadId),
  })
  const { turns } = useShellThreadTurns(projectId, threadId)
  const displayTitle =
    liveProject && threadQuery.data?.title ? threadQuery.data.title : threadTitle

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
        autoScrollToBottom={false}
        isStreaming={false}
        bottomSlot={
          <div className="pointer-events-none px-4 pb-4 pt-6">
            <div className="pointer-events-auto mx-auto w-full max-w-3xl">
              <ChatComposer
                onSubmit={(text) => {
                  console.log("[ConverseShell] submit", text)
                }}
              />
            </div>
          </div>
        }
      >
        <div className="px-4 py-4 cv-auto">
          <TurnList turns={turns} />
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
