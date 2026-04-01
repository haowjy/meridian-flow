import type { Meta, StoryObj } from "@storybook/react-vite"

import { TimelineScrubber } from "@/components/storybook/TimelineScrubber"
import { THREAD_WALKTHROUGH, THREAD_WALKTHROUGH_ACTIVE_TURN_ID } from "@/features/activity-stream/examples"
import { FloatingScrollLayout } from "@/features/chat-scroll/FloatingScrollLayout"
import { ChatComposer } from "@/features/threads/composer"
import type { TimelinePlayback } from "@/lib/use-timeline-playback"

import { TurnList } from "./components/TurnList"
import { useThreadSimulator } from "./hooks/use-thread-simulator"

function ThreadScrubberStory() {
  const simulator = useThreadSimulator({
    history: THREAD_WALKTHROUGH.history,
    activeTimeline: THREAD_WALKTHROUGH.activeTimeline,
    threadId: THREAD_WALKTHROUGH.threadId,
    activeTurnId: THREAD_WALKTHROUGH_ACTIVE_TURN_ID,
    autoplay: true,
    initialSpeed: 1,
  })
  const playback: TimelinePlayback = simulator

  return (
    <div className="h-[44rem] w-full max-w-5xl overflow-hidden rounded-xl border border-border bg-background">
      <FloatingScrollLayout
        autoScrollToBottom={simulator.state.isStreaming}
        isStreaming={simulator.state.isStreaming}
        topSlot={
          <div className="bg-gradient-to-b from-background from-80% to-transparent px-4 pb-6 pt-3">
            <div className="pointer-events-auto">
              <TimelineScrubber
                playback={playback}
                markers={simulator.turnMarkers}
                statusLabel={simulator.eventLabel}
                phaseLabel={simulator.phaseLabel}
              />
            </div>
          </div>
        }
        bottomSlot={
          <div className="pointer-events-none px-4 pb-4 pt-8 [mask-image:linear-gradient(transparent,black_24px)]">
            <div className="pointer-events-auto mx-auto w-full max-w-4xl">
              <ChatComposer
                isStreaming={simulator.state.isStreaming}
                onSubmit={(text) => {
                  console.log("[ThreadView story] submitted", text)
                }}
                onStop={() => {
                  console.log("[ThreadView story] stop requested")
                }}
              />
            </div>
          </div>
        }
      >
        <div className="py-4">
          {simulator.state.turns.length === 0 ? (
            <p className="text-sm text-muted-foreground">Waiting to load conversation history…</p>
          ) : (
            <TurnList
              turns={simulator.state.turns}
              onSwitchSibling={(targetTurnId) => {
                void simulator.store.switchSibling(targetTurnId)
              }}
            />
          )}
        </div>
      </FloatingScrollLayout>
    </div>
  )
}

const meta = {
  title: "Features/Threads/Thread View",
  component: TurnList,
  args: {
    turns: [],
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof TurnList>

export default meta
type Story = StoryObj<typeof meta>

export const Scrubber: Story = {
  render: () => <ThreadScrubberStory />,
}
