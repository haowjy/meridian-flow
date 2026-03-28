import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { createInitialState, reduceStreamEvent } from "@/features/activity-stream/streaming/reducer"
import type { TimelineEntry } from "@/features/activity-stream/streaming/types"

import type { ThreadStoreInterface, ThreadStoreState } from "../transport-types"
import type { AssistantTurn, ThreadTurn, TurnStatus } from "../types"

const DEFAULT_LOAD_DELAY_MS = 250
const MIN_SPEED = 0.1
const MAX_SPEED = 4

export type ThreadSimulatorConfig = {
  history: ThreadTurn[]
  activeTimeline: TimelineEntry[]
  threadId?: string
  activeTurnId?: string
  loadDelayMs?: number
  initialSpeed?: number
  autoplay?: boolean
}

type SimulatorPhase = "loading" | "history" | "streaming" | "complete"

export type ThreadSimulator = {
  /**
   * Storybook-only store mock. Conforms to ThreadStoreInterface shape but
   * stubs multi-thread operations: loadThread ignores fromTurnId,
   * switchSibling is a no-op, connectStream ignores turnId.
   * Do not use as a reference for real store behavior.
   */
  store: ThreadStoreInterface
  state: ThreadStoreState
  cursor: number
  maxCursor: number
  speed: number
  isPlaying: boolean
  phase: SimulatorPhase
  phaseLabel: string
  eventLabel: string
  turnMarkers: number[]
  setCursor: (nextCursor: number) => void
  setSpeed: (nextSpeed: number) => void
  play: () => void
  pause: () => void
  togglePlayPause: () => void
  stepForward: () => void
  stepBackward: () => void
  rewind: () => void
  restart: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function toTurnById(turns: ThreadTurn[]): Record<string, ThreadTurn> {
  return turns.reduce<Record<string, ThreadTurn>>((acc, turn) => {
    acc[turn.id] = turn
    return acc
  }, {})
}

function deriveActiveTurnStatus(
  streamedEventCount: number,
  totalTimelineEvents: number,
  isStreaming: boolean,
  hasError: boolean,
): TurnStatus {
  if (hasError) return "error"
  if (isStreaming) return "streaming"
  if (streamedEventCount >= totalTimelineEvents && totalTimelineEvents > 0) return "complete"
  return "pending"
}

function resolveActiveTurnId(config: ThreadSimulatorConfig): string {
  if (config.activeTurnId) {
    return config.activeTurnId
  }

  const lastHistoryTurn = config.history[config.history.length - 1]
  if (lastHistoryTurn) {
    return `${lastHistoryTurn.id}-active`
  }

  return "thread-active-turn"
}

function resolveThreadId(config: ThreadSimulatorConfig): string {
  return config.threadId ?? config.history[0]?.threadId ?? "thread-simulator"
}

function getRelativeDelayMs(
  nextCursor: number,
  timeline: TimelineEntry[],
  speed: number,
  loadDelayMs: number,
): number {
  if (nextCursor <= 0) {
    return 0
  }

  if (nextCursor === 1) {
    return loadDelayMs / speed
  }

  const timelineIndex = nextCursor - 2
  const currentDelay = timeline[timelineIndex]?.delayMs ?? 0
  const previousDelay = timelineIndex > 0 ? (timeline[timelineIndex - 1]?.delayMs ?? 0) : 0
  return Math.max(0, (currentDelay - previousDelay) / speed)
}

function buildStateAtCursor(
  config: ThreadSimulatorConfig,
  cursor: number,
  activeTurnId: string,
  threadId: string,
): ThreadStoreState {
  const maxCursor = config.activeTimeline.length + 1
  const clampedCursor = clamp(cursor, 0, maxCursor)
  const historyLoaded = clampedCursor >= 1
  const streamedEventCount = Math.max(0, clampedCursor - 1)
  const streamedEntries = config.activeTimeline.slice(0, streamedEventCount)

  const turns: ThreadTurn[] = historyLoaded ? [...config.history] : []
  let activeTurn: AssistantTurn | undefined
  let isStreaming = false

  if (streamedEntries.length > 0) {
    let streamState = createInitialState(activeTurnId)
    for (const entry of streamedEntries) {
      streamState = reduceStreamEvent(streamState, entry.event)
    }

    isStreaming = Boolean(streamState.activity.isStreaming)

    const lastHistoryTurn = config.history[config.history.length - 1]
    const status = deriveActiveTurnStatus(
      streamedEventCount,
      config.activeTimeline.length,
      isStreaming,
      Boolean(streamState.activity.error),
    )

    activeTurn = {
      id: activeTurnId,
      threadId,
      parentId: lastHistoryTurn?.id ?? null,
      role: "assistant",
      status,
      siblingIds: [activeTurnId],
      siblingIndex: 0,
      createdAt: new Date(lastHistoryTurn?.createdAt ?? Date.now()),
      model: "gpt-5.4-mini",
      activity: streamState.activity,
    }

    turns.push(activeTurn)
  }

  return {
    turns,
    turnById: toTurnById(turns),
    activeTurnId: isStreaming ? activeTurnId : null,
    hasMoreBefore: false,
    hasMoreAfter: false,
    isStreaming,
  }
}

function resolvePhase(cursor: number, maxCursor: number, isStreaming: boolean): SimulatorPhase {
  if (cursor === 0) return "loading"
  if (cursor === 1) return "history"
  if (isStreaming) return "streaming"
  if (cursor >= maxCursor) return "complete"
  return "history"
}

function buildPhaseLabel(phase: SimulatorPhase, history: ThreadTurn[]): string {
  if (phase === "loading") {
    return "Loading history..."
  }

  if (phase === "history") {
    return "History loaded"
  }

  const assistantTurnCount = history.filter((turn) => turn.role === "assistant").length + 1
  if (phase === "streaming") {
    return `Streaming turn ${assistantTurnCount}`
  }

  return `Turn ${assistantTurnCount} complete`
}

function buildTurnMarkers(activeTimeline: TimelineEntry[]): number[] {
  const markers = new Set<number>([1])
  for (let index = 0; index < activeTimeline.length; index += 1) {
    if (activeTimeline[index]?.event.type === "RUN_STARTED") {
      markers.add(index + 2)
    }
  }
  return [...markers].sort((a, b) => a - b)
}

/**
 * Storybook-only hook that simulates a single-thread conversation with
 * cursor-based playback. The returned store conforms to ThreadStoreInterface
 * shape but stubs multi-thread operations (loadThread, switchSibling,
 * connectStream). See ThreadSimulator.store JSDoc for details.
 */
export function useThreadSimulator(config: ThreadSimulatorConfig): ThreadSimulator {
  const maxCursor = config.activeTimeline.length + 1
  const loadDelayMs = config.loadDelayMs ?? DEFAULT_LOAD_DELAY_MS
  const activeTurnId = useMemo(() => resolveActiveTurnId(config), [config])
  const threadId = useMemo(() => resolveThreadId(config), [config])

  const [cursor, setCursorState] = useState(0)
  const [isPlaying, setIsPlaying] = useState(Boolean(config.autoplay))
  const [speed, setSpeedState] = useState(
    clamp(config.initialSpeed ?? 1, MIN_SPEED, MAX_SPEED),
  )
  const [activeThreadId, setActiveThreadId] = useState(threadId)

  useEffect(() => {
    setActiveThreadId(threadId)
  }, [threadId])

  const setCursor = useCallback(
    (nextCursor: number) => {
      setCursorState(clamp(nextCursor, 0, maxCursor))
    },
    [maxCursor],
  )

  const setSpeed = useCallback((nextSpeed: number) => {
    setSpeedState(clamp(nextSpeed, MIN_SPEED, MAX_SPEED))
  }, [])

  useEffect(() => {
    if (!isPlaying) {
      return
    }

    if (cursor >= maxCursor) {
      setIsPlaying(false)
      return
    }

    const nextCursor = cursor + 1
    const delayMs = getRelativeDelayMs(nextCursor, config.activeTimeline, speed, loadDelayMs)
    const timer = setTimeout(() => {
      setCursorState(nextCursor)
    }, delayMs)

    return () => {
      clearTimeout(timer)
    }
  }, [config.activeTimeline, cursor, isPlaying, loadDelayMs, maxCursor, speed])

  const state = useMemo(
    () =>
      buildStateAtCursor(
        {
          ...config,
          threadId: activeThreadId,
        },
        cursor,
        activeTurnId,
        activeThreadId,
      ),
    [activeThreadId, activeTurnId, config, cursor],
  )

  const stateRef = useRef(state)
  stateRef.current = state

  const play = useCallback(() => {
    setIsPlaying(true)
  }, [])

  const pause = useCallback(() => {
    setIsPlaying(false)
  }, [])

  const togglePlayPause = useCallback(() => {
    setIsPlaying((current) => !current)
  }, [])

  const stepForward = useCallback(() => {
    setIsPlaying(false)
    setCursorState((current) => clamp(current + 1, 0, maxCursor))
  }, [maxCursor])

  const stepBackward = useCallback(() => {
    setIsPlaying(false)
    setCursorState((current) => clamp(current - 1, 0, maxCursor))
  }, [maxCursor])

  const rewind = useCallback(() => {
    setIsPlaying(false)
    setCursorState(0)
  }, [])

  const restart = useCallback(() => {
    setCursorState(0)
    setIsPlaying(true)
  }, [])

  /**
   * Storybook stub: single-thread simulator ignores fromTurnId since there's
   * only one thread with one linear history. Real store loads the active path
   * from the specified turn.
   */
  const loadThread = useCallback(
    async (nextThreadId: string, fromTurnId?: string) => {
      void fromTurnId
      setActiveThreadId(nextThreadId)
      setCursorState((current) => (current === 0 ? 1 : current))
    },
    [],
  )

  /**
   * Storybook stub: no-op. Phase 2 shows static sibling controls only.
   * Real store reloads the active path from the selected sibling forward.
   */
  const switchSibling = useCallback(async (targetTurnId: string) => {
    void targetTurnId
  }, [])

  /**
   * Storybook stub: ignores turnId since the simulator has a single active
   * turn. Real store subscribes to SSE for the specified turn.
   */
  const connectStream = useCallback((nextThreadId: string, turnId: string) => {
    void turnId
    setActiveThreadId(nextThreadId)
    setIsPlaying((current) => current || cursor < maxCursor)
  }, [cursor, maxCursor])

  const disconnectStream = useCallback(() => {
    setIsPlaying(false)
  }, [])

  const store = useMemo<ThreadStoreInterface>(
    () => ({
      loadThread,
      paginateBefore: async () => {},
      paginateAfter: async () => {},
      switchSibling,
      connectStream,
      disconnectStream,
      get state() {
        return stateRef.current
      },
    }),
    [connectStream, disconnectStream, loadThread, switchSibling],
  )

  const phase = resolvePhase(cursor, maxCursor, state.isStreaming)
  const phaseLabel = buildPhaseLabel(phase, config.history)
  const eventLabel = `Event ${cursor}/${maxCursor}`
  const turnMarkers = useMemo(() => buildTurnMarkers(config.activeTimeline), [config.activeTimeline])

  return {
    store,
    state,
    cursor,
    maxCursor,
    speed,
    isPlaying,
    phase,
    phaseLabel,
    eventLabel,
    turnMarkers,
    setCursor,
    setSpeed,
    play,
    pause,
    togglePlayPause,
    stepForward,
    stepBackward,
    rewind,
    restart,
  }
}
