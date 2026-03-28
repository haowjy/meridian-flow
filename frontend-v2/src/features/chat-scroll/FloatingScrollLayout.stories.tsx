import { PaperPlaneTilt, Plus, X } from "@phosphor-icons/react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import { FloatingScrollLayout } from "./FloatingScrollLayout"

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
}

const mockMessages: ChatMessage[] = [
  {
    id: "1",
    role: "user",
    content: "Chapter 5 feels flat. Can you help me diagnose the pacing in the middle section?",
  },
  {
    id: "2",
    role: "assistant",
    content:
      "The middle drifts because three scenes repeat the same emotional beat: hesitation. Try compressing the market walk and moving the reveal of the iron key into scene two.",
  },
  {
    id: "3",
    role: "user",
    content: "If I cut the market walk, what do I lose from Mira's voice?",
  },
  {
    id: "4",
    role: "assistant",
    content:
      "You keep her observational wit if you preserve one sensory line and one judgment line. Everything else can become subtext inside dialogue with Varen.",
  },
  {
    id: "5",
    role: "user",
    content: "Can you pitch an alternate opening line for the chapter?",
  },
  {
    id: "6",
    role: "assistant",
    content:
      "Try: \"By the time the bell cracked dawn in half, Mira had already lied twice.\" It sets urgency and hints at moral friction.",
  },
  {
    id: "7",
    role: "user",
    content: "I want the antagonist to feel dangerous without sounding cartoonish.",
  },
  {
    id: "8",
    role: "assistant",
    content:
      "Give him precise, calm language when everyone else is emotional. Controlled diction can read as more threatening than raised volume.",
  },
  {
    id: "9",
    role: "user",
    content: "Where should I place the cliffhanger beat?",
  },
  {
    id: "10",
    role: "assistant",
    content:
      "Place it right after Mira commits to the false plan. End on consequence, not intent: the vault door answering with a voice she recognizes.",
  },
  {
    id: "11",
    role: "user",
    content: "Can you suggest one line for Lio that foreshadows betrayal?",
  },
  {
    id: "12",
    role: "assistant",
    content:
      "Lio could say: \"I promised I'd stay until the end. I never said whose end.\"",
  },
  {
    id: "13",
    role: "user",
    content: "I think Chapter 6 repeats Chapter 4's argument structure.",
  },
  {
    id: "14",
    role: "assistant",
    content:
      "Good catch. In Chapter 6, flip the power dynamic by letting Mira ask the dangerous question first, then force Varen to evade.",
  },
  {
    id: "15",
    role: "user",
    content: "How many words should this chapter target if I want snappier pacing?",
  },
  {
    id: "16",
    role: "assistant",
    content:
      "Aim for 1,800 to 2,200 words. Keep scene transitions abrupt and let implications carry weight between scenes.",
  },
  {
    id: "17",
    role: "user",
    content: "Can you rewrite this sentence to sound less modern?",
  },
  {
    id: "18",
    role: "assistant",
    content:
      "Share the exact line and I can produce three variants: restrained courtly, poetic, and iron-edged formal.",
  },
  {
    id: "19",
    role: "user",
    content: "I'm worried the chapter ends without emotional closure.",
  },
  {
    id: "20",
    role: "assistant",
    content:
      "Add a one-paragraph stillness beat after the action where Mira notices one ordinary object changed by the conflict. Concrete aftermath creates closure.",
  },
  {
    id: "21",
    role: "user",
    content: "Can you give me a stronger chapter title than 'After the Bells'?",
  },
  {
    id: "22",
    role: "assistant",
    content: "Try \"When the Ninth Bell Lied\" for mystery and momentum.",
  },
]

const chapterEightMessages: ChatMessage[] = [
  {
    id: "chapter8-1",
    role: "user",
    content: "The siege chapter reads louder than it feels. Can we tune the emotional beat?",
  },
  {
    id: "chapter8-2",
    role: "assistant",
    content:
      "Anchor each tactical move to one cost. If every advance forces Mira to lose something personal, tension climbs without extra noise.",
  },
  {
    id: "chapter8-3",
    role: "user",
    content: "Where should the betrayal reveal hit for maximum shock?",
  },
  {
    id: "chapter8-4",
    role: "assistant",
    content:
      "Reveal it after the apparent victory. Let the celebration crest first so the collapse feels immediate and irreversible.",
  },
  {
    id: "chapter8-5",
    role: "user",
    content: "Can you give me one cleaner closing line?",
  },
  {
    id: "chapter8-6",
    role: "assistant",
    content: "End with action: \"Mira smiled, then barred the gate from the wrong side.\"",
  },
]

type DemoThreadId = "chapter-5" | "chapter-8"

const STREAMING_CHUNKS = [
  "Start with a tighter opening image, ",
  "then cut directly to the decision point. ",
  "Each paragraph should force Mira to choose, ",
  "not just observe. ",
  "That keeps token-by-token updates meaningful ",
  "and the scroll behavior easy to evaluate.",
]

const initialThreadMap: Record<DemoThreadId, { title: string; messages: ChatMessage[] }> = {
  "chapter-5": {
    title: "Chapter 5 Discussion",
    messages: mockMessages.slice(0, 12),
  },
  "chapter-8": {
    title: "Chapter 8 Siege Pass",
    messages: chapterEightMessages,
  },
}

function MockToolbar({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="border-b border-border/80 bg-background/90 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <div className="flex items-center gap-2">
          {actions}
          <Button type="button" variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Close thread">
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function MockComposer({ placeholder = "Ask for chapter feedback..." }: { placeholder?: string }) {
  return (
    <div className="border-t border-border/80 bg-background/90 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-2">
        <div className="flex-1">
          <Input aria-label="Message composer" placeholder={placeholder} className="h-10" />
        </div>
        <Button type="button" size="icon" className="size-10 rounded-full" aria-label="Send message">
          <PaperPlaneTilt className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

function MockUserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <article className="max-w-[80%] rounded-xl border border-border/80 bg-card px-4 py-3 text-sm leading-relaxed text-card-foreground shadow-sm">
        {content}
      </article>
    </div>
  )
}

function MockAIMessage({ content }: { content: string }) {
  return (
    <article className="text-sm leading-relaxed text-foreground">
      <p className="max-w-none">{content}</p>
    </article>
  )
}

function MockThread({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="space-y-4">
      {messages.map((message) =>
        message.role === "user" ? (
          <MockUserMessage key={message.id} content={message.content} />
        ) : (
          <MockAIMessage key={message.id} content={message.content} />
        )
      )}
    </div>
  )
}

function Frame({
  children,
  topSlot,
  bottomSlot,
  autoScrollToBottom,
  showScrollToBottom,
  isStreaming,
  resetKey,
  className,
}: {
  children: ReactNode
  topSlot?: ReactNode
  bottomSlot?: ReactNode
  autoScrollToBottom?: boolean
  showScrollToBottom?: boolean
  isStreaming?: boolean
  resetKey?: string
  className?: string
}) {
  return (
    <div className={cn("h-[44rem] w-full max-w-4xl rounded-xl border border-border bg-background", className)}>
      <FloatingScrollLayout
        topSlot={topSlot}
        bottomSlot={bottomSlot}
        autoScrollToBottom={autoScrollToBottom}
        showScrollToBottom={showScrollToBottom}
        isStreaming={isStreaming}
        resetKey={resetKey}
      >
        {children}
      </FloatingScrollLayout>
    </div>
  )
}

function AutoScrollDemoView() {
  const [count, setCount] = useState(10)

  const messages = mockMessages.slice(0, count)
  const canAddMessage = count < mockMessages.length

  return (
    <Frame
      topSlot={
        <MockToolbar
          title="Chapter 5 Discussion"
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canAddMessage}
              onClick={() => {
                setCount((current) => Math.min(current + 1, mockMessages.length))
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              Add Message
            </Button>
          }
        />
      }
      bottomSlot={<MockComposer placeholder="Type and then click Add Message above..." />}
    >
      <MockThread messages={messages} />
      <p className="text-center text-xs text-muted-foreground">
        Scroll up, then add a message to verify auto-scroll detaches until you jump back down.
      </p>
    </Frame>
  )
}

type StreamingSession = {
  threadId: DemoThreadId
  messageId: string
  nextChunkIndex: number
}

function StreamingDemoView() {
  const [activeThreadId, setActiveThreadId] = useState<DemoThreadId>("chapter-5")
  const [threads, setThreads] = useState(initialThreadMap)
  const [streamingSession, setStreamingSession] = useState<StreamingSession | null>(null)

  const activeThread = threads[activeThreadId]
  const isStreaming = streamingSession?.threadId === activeThreadId

  const startStreamingReply = () => {
    if (streamingSession) {
      return
    }

    const streamMessageId = `stream-${Date.now()}`
    const targetThreadId = activeThreadId

    setThreads((current) => ({
      ...current,
      [targetThreadId]: {
        ...current[targetThreadId],
        messages: [
          ...current[targetThreadId].messages,
          {
            id: streamMessageId,
            role: "assistant",
            content: "",
          },
        ],
      },
    }))
    setStreamingSession({
      threadId: targetThreadId,
      messageId: streamMessageId,
      nextChunkIndex: 0,
    })
  }

  useEffect(() => {
    if (!streamingSession) {
      return
    }

    const timeout = window.setTimeout(() => {
      const chunk = STREAMING_CHUNKS[streamingSession.nextChunkIndex]
      if (!chunk) {
        setStreamingSession(null)
        return
      }

      setThreads((current) => {
        const thread = current[streamingSession.threadId]
        return {
          ...current,
          [streamingSession.threadId]: {
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === streamingSession.messageId
                ? { ...message, content: `${message.content}${chunk}` }
                : message
            ),
          },
        }
      })

      setStreamingSession((current) => {
        if (!current) {
          return current
        }

        if (current.nextChunkIndex >= STREAMING_CHUNKS.length - 1) {
          return null
        }

        return {
          ...current,
          nextChunkIndex: current.nextChunkIndex + 1,
        }
      })
    }, 65)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [streamingSession])

  const toggleThread = () => {
    setActiveThreadId((current) => (current === "chapter-5" ? "chapter-8" : "chapter-5"))
  }

  return (
    <Frame
      topSlot={
        <MockToolbar
          title={`${activeThread.title}${isStreaming ? " (Streaming)" : ""}`}
          actions={
            <>
              <Button type="button" size="sm" variant="outline" onClick={toggleThread}>
                Switch Thread
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(streamingSession)}
                onClick={startStreamingReply}
              >
                Stream Reply
              </Button>
            </>
          }
        />
      }
      bottomSlot={<MockComposer placeholder="Scroll up during streaming to detach auto-follow..." />}
      isStreaming={isStreaming}
      resetKey={activeThreadId}
    >
      <MockThread messages={activeThread.messages} />
      <p className="text-center text-xs text-muted-foreground">
        Start streaming, scroll up to detach, then use the down button to reattach. Switch threads to check reset gating.
      </p>
    </Frame>
  )
}

const meta = {
  title: "Features/Threads/Chat Scroll",
  component: FloatingScrollLayout,
  args: {
    children: null,
  },
  tags: ["autodocs"],
} satisfies Meta<typeof FloatingScrollLayout>

export default meta
type Story = StoryObj<typeof meta>

export const ChatThread: Story = {
  render: () => (
    <Frame topSlot={<MockToolbar title="Chapter 5 Discussion" />} bottomSlot={<MockComposer />}>
      <MockThread messages={mockMessages} />
    </Frame>
  ),
}

export const WithScrollToBottom: Story = {
  render: () => (
    <Frame
      topSlot={<MockToolbar title="Chapter 5 Discussion" />}
      bottomSlot={<MockComposer />}
      autoScrollToBottom={false}
      showScrollToBottom
    >
      <MockThread messages={mockMessages} />
    </Frame>
  ),
}

export const ShortContent: Story = {
  render: () => (
    <Frame topSlot={<MockToolbar title="Chapter 5 Discussion" />} bottomSlot={<MockComposer />}>
      <MockThread messages={mockMessages.slice(0, 3)} />
    </Frame>
  ),
}

export const TopSlotOnly: Story = {
  render: () => (
    <Frame topSlot={<MockToolbar title="Chapter 5 Discussion" />}>
      <MockThread messages={mockMessages} />
    </Frame>
  ),
}

export const BottomSlotOnly: Story = {
  render: () => (
    <Frame bottomSlot={<MockComposer />}>
      <MockThread messages={mockMessages} />
    </Frame>
  ),
}

export const AutoScrollDemo: Story = {
  render: () => <AutoScrollDemoView />,
}

export const StreamingIntegrationDemo: Story = {
  render: () => <StreamingDemoView />,
}
