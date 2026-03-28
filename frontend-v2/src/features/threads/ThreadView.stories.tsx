import type { Meta, StoryObj } from "@storybook/react-vite"

import { TimelineScrubber } from "@/components/storybook/TimelineScrubber"
import { THREAD_WALKTHROUGH, THREAD_WALKTHROUGH_ACTIVE_TURN_ID } from "@/features/activity-stream/examples"
import { FloatingScrollLayout } from "@/features/chat-scroll/FloatingScrollLayout"
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
    <div className="h-[44rem] w-full max-w-5xl rounded-xl border border-border bg-background">
      <FloatingScrollLayout
        autoScrollToBottom={simulator.state.isStreaming}
        isStreaming={simulator.state.isStreaming}
        topSlot={
          <div className="border-b border-border/80 bg-background/90 px-4 py-3 backdrop-blur">
            <TimelineScrubber
              playback={playback}
              markers={simulator.turnMarkers}
              statusLabel={simulator.eventLabel}
              phaseLabel={simulator.phaseLabel}
            />
          </div>
        }
      >
        <div className="mx-auto w-full max-w-4xl py-4">
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
