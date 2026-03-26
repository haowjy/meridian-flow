import { useCallback, useMemo, useRef, useState } from "react"

import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"

import { ActivityBlock } from "./ActivityBlock"
import { STREAM_EVENT_TYPE_SET } from "./streaming/events"
import type { StreamEvent } from "./streaming/events"
import { PACING_FIX_SCENARIO } from "./streaming/scenario"
import type { TimelineEntry } from "./streaming/types"
import { useStreamSimulator } from "./streaming/use-stream-simulator"

type TimelineParseResult =
  | { ok: true; timeline: TimelineEntry[] }
  | { ok: false; error: string }

type EventLogEntry = {
  sequence: number
  firedAtMs: number
  plannedDelayMs: number
  type: StreamEvent["type"]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serializeTimeline(timeline: TimelineEntry[]): string {
  return JSON.stringify(timeline, null, 2)
}

function parseTimelineText(value: string): TimelineParseResult {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    return { ok: false, error: "Timeline must be valid JSON." }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: "Timeline must be a JSON array of { delayMs, event } entries." }
  }

  const timeline: TimelineEntry[] = []

  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index]
    if (!isRecord(entry)) {
      return { ok: false, error: `Entry ${index + 1} must be an object.` }
    }

    const delayMs = entry.delayMs
    const event = entry.event

    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) {
      return { ok: false, error: `Entry ${index + 1} has invalid delayMs.` }
    }

    if (!isRecord(event) || typeof event.type !== "string") {
      return { ok: false, error: `Entry ${index + 1} has invalid event.` }
    }

    if (!STREAM_EVENT_TYPE_SET.has(event.type)) {
      return { ok: false, error: `Entry ${index + 1} uses unknown event.type "${event.type}".` }
    }

    if (index > 0) {
      const previousDelayMs = timeline[index - 1]?.delayMs ?? 0
      if (delayMs < previousDelayMs) {
        return {
          ok: false,
          error: `Entry ${index + 1} delayMs must be >= entry ${index} delayMs.`,
        }
      }
    }

    timeline.push({
      delayMs,
      event: event as StreamEvent,
    })
  }

  return { ok: true, timeline }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const millis = Math.floor(ms % 1000)

  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`
}

/**
 * Editor-oriented wrapper around useStreamSimulator.
 *
 * Adds mutable timeline, event logging, step-through debugging,
 * and replaceTimeline (for the JSON editor) on top of the base hook.
 */
function useStreamingEditorSimulator(id: string, initialTimeline: TimelineEntry[]) {
  const [timeline, setTimeline] = useState(initialTimeline)
  const [speed, setSpeed] = useState(1)
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([])
  const runStartRef = useRef<number>(performance.now())

  const onEvent = useCallback((entry: TimelineEntry) => {
    const firedAtMs = Math.max(0, performance.now() - runStartRef.current)
    setEventLog((current) => [
      ...current,
      {
        sequence: current.length + 1,
        firedAtMs,
        plannedDelayMs: entry.delayMs,
        type: entry.event.type,
      },
    ])
  }, [])

  const {
    activity,
    restart,
    paused,
    setPaused,
    step: baseStep,
    progress,
  } = useStreamSimulator(id, timeline, speed, { onEvent })

  const isPlaying = !paused
  const cursor = progress.current

  const setIsPlaying = useCallback(
    (updater: boolean | ((current: boolean) => boolean)) => {
      if (typeof updater === "function") {
        setPaused((p) => !updater(!p))
      } else {
        setPaused(!updater)
      }
    },
    [setPaused],
  )

  const reset = useCallback(() => {
    setEventLog([])
    runStartRef.current = performance.now()
    restart()
  }, [restart])

  const replaceTimeline = useCallback(
    (nextTimeline: TimelineEntry[]) => {
      setTimeline(nextTimeline)
      setEventLog([])
      runStartRef.current = performance.now()
      // Preserve pause state — user may be editing JSON while paused for step-through.
      restart({ preservePause: true })
    },
    [restart],
  )

  return {
    activity,
    timeline,
    cursor,
    isPlaying,
    speed,
    eventLog,
    setIsPlaying,
    setSpeed,
    step: baseStep,
    reset,
    replaceTimeline,
  }
}

const meta = {
  title: "Features/ActivityStream/ActivityBlock/Streaming Editor",
  component: ActivityBlock,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ActivityBlock>

export default meta
type Story = StoryObj<typeof meta>

export const StreamingEditor: Story = {
  render: function StreamingEditorStory() {
    const initialTimelineText = useMemo(() => serializeTimeline(PACING_FIX_SCENARIO), [])
    const [editorValue, setEditorValue] = useState(initialTimelineText)
    const [parseError, setParseError] = useState<string | null>(null)

    const {
      activity,
      timeline,
      cursor,
      isPlaying,
      speed,
      eventLog,
      setIsPlaying,
      setSpeed,
      step,
      reset,
      replaceTimeline,
    } = useStreamingEditorSimulator("streaming-editor", PACING_FIX_SCENARIO)

    const hasNextEvent = cursor < timeline.length
    const isActivelyPlaying = isPlaying && hasNextEvent

    const onEditorChange = useCallback(
      (nextValue: string) => {
        setEditorValue(nextValue)

        const parsed = parseTimelineText(nextValue)
        if (!parsed.ok) {
          setParseError(parsed.error)
          return
        }

        setParseError(null)
        replaceTimeline(parsed.timeline)
      },
      [replaceTimeline],
    )

    return (
      <div className="h-full min-h-screen bg-background px-4 py-4 font-mono md:px-6">
        <div className="mx-auto max-w-[1440px] space-y-4">
          <div className="rounded-md border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={isActivelyPlaying ? "default" : "outline"}
                size="sm"
                onClick={() => setIsPlaying((current) => !current)}
                disabled={!hasNextEvent}
              >
                {isActivelyPlaying ? "Pause" : "Play"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={step}
                disabled={isPlaying || !hasNextEvent || Boolean(parseError)}
              >
                Step
              </Button>
              <Button variant="outline" size="sm" onClick={reset}>
                Reset
              </Button>

              <label className="ml-2 flex items-center gap-2 text-xs text-muted-foreground">
                Speed
                <input
                  type="range"
                  min={0.5}
                  max={4}
                  step={0.25}
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                  className="w-40"
                />
                <span className="w-12 text-right text-foreground">{speed.toFixed(2)}x</span>
              </label>

              <span className="ml-auto text-xs text-muted-foreground">
                Event {Math.min(cursor, timeline.length)}/{timeline.length}
              </span>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-md border border-border bg-card p-3">
              <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                Timeline Editor (JSON from scenario.ts)
              </div>
              <textarea
                value={editorValue}
                onChange={(event) => onEditorChange(event.target.value)}
                spellCheck={false}
                className="h-[560px] w-full resize-none rounded border border-border bg-background p-3 font-mono text-xs leading-5"
              />
              <div className="mt-2 text-xs">
                {parseError ? (
                  <span className="text-destructive">{parseError}</span>
                ) : (
                  <span className="text-muted-foreground">
                    Valid timeline loaded. Changes replay immediately from event 1.
                  </span>
                )}
              </div>
            </section>

            <section className="rounded-md border border-border bg-card p-3">
              <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                Live ActivityBlock Output
              </div>
              <ActivityBlock activity={activity} defaultExpanded />
            </section>
          </div>

          <section className="rounded-md border border-border bg-card p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              Event Log
            </div>
            {eventLog.length === 0 ? (
              <p className="text-xs text-muted-foreground">No events fired yet.</p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded border border-border bg-background p-2 text-xs">
                {eventLog.map((entry) => (
                  <li
                    key={entry.sequence}
                    className="grid grid-cols-[110px_160px_1fr] gap-3 border-b border-border/40 pb-1 last:border-b-0"
                  >
                    <span className="text-muted-foreground">{formatElapsed(entry.firedAtMs)}</span>
                    <span className="text-muted-foreground">delay {entry.plannedDelayMs}ms</span>
                    <span className="text-foreground">{entry.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    )
  },
}
