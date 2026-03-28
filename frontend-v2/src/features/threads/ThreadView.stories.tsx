import { Pause, Play, Rewind, SkipBack, SkipForward } from "@phosphor-icons/react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { THREAD_WALKTHROUGH, THREAD_WALKTHROUGH_ACTIVE_TURN_ID } from "@/features/activity-stream/examples"
import { FloatingScrollLayout } from "@/features/chat-scroll/FloatingScrollLayout"
import { cn } from "@/lib/utils"

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

  const markerTrackWidth = simulator.maxCursor > 0 ? simulator.maxCursor : 1

  return (
    <div className="h-[44rem] w-full max-w-5xl rounded-xl border border-border bg-background">
      <FloatingScrollLayout
        autoScrollToBottom={simulator.state.isStreaming}
        isStreaming={simulator.state.isStreaming}
        topSlot={
          <div className="border-b border-border/80 bg-background/90 px-4 py-3 backdrop-blur">
            <div className="mx-auto w-full max-w-4xl space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={simulator.rewind}
                  disabled={simulator.cursor === 0}
                >
                  <Rewind className="size-3.5" aria-hidden="true" />
                  Rewind
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={simulator.stepBackward}
                  disabled={simulator.cursor === 0}
                >
                  <SkipBack className="size-3.5" aria-hidden="true" />
                  Step Back
                </Button>
                <Button
                  type="button"
                  variant={simulator.isPlaying ? "default" : "outline"}
                  size="sm"
                  onClick={simulator.togglePlayPause}
                  disabled={simulator.cursor >= simulator.maxCursor}
                >
                  {simulator.isPlaying ? (
                    <Pause className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Play className="size-3.5" aria-hidden="true" />
                  )}
                  {simulator.isPlaying ? "Pause" : "Play"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={simulator.stepForward}
                  disabled={simulator.cursor >= simulator.maxCursor}
                >
                  <SkipForward className="size-3.5" aria-hidden="true" />
                  Step
                </Button>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Speed</span>
                  <Slider
                    className="w-28"
                    min={0.1}
                    max={4}
                    step={0.1}
                    value={[simulator.speed]}
                    onValueChange={([value]) => {
                      if (typeof value === "number") {
                        simulator.setSpeed(value)
                      }
                    }}
                  />
                  <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                    {simulator.speed.toFixed(1)}x
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <div className="relative">
                  <Slider
                    min={0}
                    max={simulator.maxCursor}
                    step={1}
                    value={[simulator.cursor]}
                    onValueChange={([value]) => {
                      if (typeof value === "number") {
                        simulator.pause()
                        simulator.setCursor(value)
                      }
                    }}
                  />
                  <div className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2">
                    {simulator.turnMarkers.map((marker, index) => (
                      <span
                        key={`${marker}-${index}`}
                        className={cn(
                          "absolute size-2 -translate-x-1/2 rounded-full border border-background",
                          marker <= simulator.cursor ? "bg-accent-fill" : "bg-muted",
                        )}
                        style={{
                          left: `${(marker / markerTrackWidth) * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums">{simulator.eventLabel}</span>
                  <Badge variant="outline" className="h-5 rounded-full px-2 text-[10px] uppercase tracking-wide">
                    {simulator.phaseLabel}
                  </Badge>
                </div>
              </div>
            </div>
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
