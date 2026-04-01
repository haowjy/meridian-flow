import { useState } from "react"

import type { Meta, StoryObj } from "@storybook/react-vite"

import { ChatComposer } from "./ChatComposer"

function ComposerDemo() {
  const [messages, setMessages] = useState<string[]>([])
  const [isStreaming, setIsStreaming] = useState(false)

  const handleSubmit = (text: string) => {
    setMessages((prev) => [...prev, text])
    setIsStreaming(true)
    // Simulate streaming for 3 seconds
    setTimeout(() => setIsStreaming(false), 3000)
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col bg-background">
      {/* Message area */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="pt-8 text-center text-sm text-muted-foreground">
            Send a message to see it appear here.
          </p>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] rounded-xl border border-border/80 bg-card px-4 py-3 text-sm">
                {msg}
              </div>
            </div>
          ))
        )}
        {isStreaming ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-primary" />
            Generating response…
          </div>
        ) : null}
      </div>

      {/* Composer */}
      <div className="border-t border-border/80 bg-background/90 p-4 backdrop-blur">
        <ChatComposer onSubmit={handleSubmit} isStreaming={isStreaming} onStop={() => setIsStreaming(false)} />
      </div>
    </div>
  )
}

const meta = {
  title: "Features/Threads/Chat Composer",
  component: ChatComposer,
  args: {
    onSubmit: () => {},
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ChatComposer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <ComposerDemo />,
}
