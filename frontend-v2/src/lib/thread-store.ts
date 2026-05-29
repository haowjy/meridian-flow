// ═══════════════════════════════════════════════════════════════════
// Thread store — Zustand store for active thread turn state.
//
// Manages the turn list for the currently viewed thread. Handles:
// - Load thread (paginated REST)
// - Send message (POST → merge → subscribe to stream)
// - Streaming state (AG-UI reducer integration)
// - Edit, regenerate, sibling navigation
// - Interrupt + interjection
//
// TanStack Query is NOT used for turns — streaming requires imperative,
// fine-grained updates that don't fit stale-while-revalidate.
// ═══════════════════════════════════════════════════════════════════

import { create } from "zustand"

import type { StreamEvent } from "@/features/activity-stream/streaming/events"
import {
  createInitialState,
  reduceStreamEvent,
  type StreamState,
} from "@/features/activity-stream/streaming/reducer"
import type { BackendTurn } from "@/features/threads/transport-types"
import { mapTurnToViewModel } from "@/features/threads/turn-mapper"
import type { AssistantTurn, ThreadTurn } from "@/features/threads/types"
import { api } from "@/lib/api"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoadStatus = "idle" | "loading" | "error"

export interface ThreadStoreState {
  // Thread identity
  threadId: string | null
  projectId: string | null

  // Turn data (normalized)
  turnIds: string[]
  turnById: Record<string, ThreadTurn>

  // Pagination
  hasMoreBefore: boolean
  hasMoreAfter: boolean

  // Loading
  loadStatus: LoadStatus
  error: string | null

  // Streaming
  activeStreamTurnId: string | null
  isStreaming: boolean
  /** Internal stream reducer state — not for direct consumption */
  _streamState: StreamState | null
}

export interface ThreadStoreActions {
  // Thread lifecycle
  loadThread: (threadId: string, fromTurnId?: string) => Promise<void>
  clearThread: () => void

  // Sending
  sendMessage: (
    text: string,
    options: {
      projectId?: string
      threadId?: string
      prevTurnId?: string | null
    },
  ) => Promise<{
    threadId: string
    assistantTurnId: string
  }>

  // Streaming (called by the streaming bridge, not by UI directly)
  applyStreamEvent: (turnId: string, event: StreamEvent) => void
  handleStreamEnded: (
    turnId: string,
    reason: string,
    payload: Record<string, unknown>,
  ) => void

  // History operations
  switchSibling: (targetTurnId: string) => Promise<void>
  editTurn: (
    turnId: string,
    newText: string,
  ) => Promise<{ assistantTurnId: string } | undefined>
  regenerateTurn: (assistantTurnId: string) => Promise<{ assistantTurnId: string } | undefined>

  // Interrupt
  interruptStream: () => Promise<void>

  // Pagination
  paginateBefore: () => Promise<void>
  paginateAfter: () => Promise<void>

  // Error
  clearError: () => void
}

export type ThreadStore = ThreadStoreState & ThreadStoreActions

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeTurns(backendTurns: BackendTurn[]): {
  turnIds: string[]
  turnById: Record<string, ThreadTurn>
} {
  const turnIds: string[] = []
  const turnById: Record<string, ThreadTurn> = {}
  const seen = new Set<string>()

  for (const bt of backendTurns) {
    const turn = mapTurnToViewModel(bt)
    if (!seen.has(turn.id)) {
      seen.add(turn.id)
      turnIds.push(turn.id)
    }
    turnById[turn.id] = turn
  }

  return { turnIds, turnById }
}

function mergeTurnIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  return fallback
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const INITIAL_STATE: ThreadStoreState = {
  threadId: null,
  projectId: null,
  turnIds: [],
  turnById: {},
  hasMoreBefore: false,
  hasMoreAfter: false,
  loadStatus: "idle",
  error: null,
  activeStreamTurnId: null,
  isStreaming: false,
  _streamState: null,
}

export const useThreadStore = create<ThreadStore>()((set, get) => ({
  ...INITIAL_STATE,

  // -----------------------------------------------------------------------
  // Thread lifecycle
  // -----------------------------------------------------------------------

  loadThread: async (threadId: string, fromTurnId?: string) => {
    set({
      threadId,
      loadStatus: "loading",
      error: null,
      turnIds: [],
      turnById: {},
      activeStreamTurnId: null,
      isStreaming: false,
      _streamState: null,
    })

    try {
      const page = await api.turns.paginate(threadId, {
        fromTurnId,
        direction: "both",
        limit: 100,
      })

      // Staleness guard
      if (get().threadId !== threadId) return

      const { turnIds, turnById } = normalizeTurns(page.turns)

      set({
        turnIds,
        turnById,
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: page.hasMoreAfter,
        loadStatus: "idle",
      })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return
      if (get().threadId !== threadId) return

      set({
        error: getErrorMessage(error, "Failed to load thread"),
        loadStatus: "error",
      })
    }
  },

  clearThread: () => {
    set(INITIAL_STATE)
  },

  // -----------------------------------------------------------------------
  // Sending
  // -----------------------------------------------------------------------

  sendMessage: async (text, options) => {
    const state = get()
    const threadId = options.threadId ?? state.threadId
    const projectId = options.projectId ?? state.projectId

    // Determine prevTurnId: last turn in current list
    const prevTurnId =
      options.prevTurnId !== undefined
        ? options.prevTurnId
        : state.turnIds.length > 0
          ? state.turnIds[state.turnIds.length - 1]
          : null

    set({ error: null })

    try {
      const result = await api.turns.send(text, {
        threadId: threadId ?? undefined,
        projectId: projectId ?? undefined,
        prevTurnId,
      })

      const { turnIds: incomingIds, turnById: incomingById } = normalizeTurns([
        result.userTurn,
        result.assistantTurn,
      ])

      const newThreadId = result.thread?.id ?? threadId ?? state.threadId

      // Initialize stream state for the assistant turn
      const streamState = createInitialState(result.assistantTurn.id)

      set((s) => ({
        threadId: newThreadId,
        projectId: projectId ?? s.projectId,
        turnIds: mergeTurnIds([...s.turnIds, ...incomingIds]),
        turnById: { ...s.turnById, ...incomingById },
        activeStreamTurnId: result.assistantTurn.id,
        isStreaming: true,
        _streamState: streamState,
      }))

      return {
        threadId: newThreadId!,
        assistantTurnId: result.assistantTurn.id,
      }
    } catch (error) {
      set({
        error: getErrorMessage(error, "Failed to send message"),
      })
      throw error
    }
  },

  // -----------------------------------------------------------------------
  // Streaming
  // -----------------------------------------------------------------------

  applyStreamEvent: (turnId: string, event: StreamEvent) => {
    const state = get()
    if (state.activeStreamTurnId !== turnId || !state._streamState) return

    const nextStreamState = reduceStreamEvent(state._streamState, event)

    // Update the assistant turn's activity with the new stream state
    const existingTurn = state.turnById[turnId]
    if (!existingTurn || existingTurn.role !== "assistant") return

    const updatedTurn: AssistantTurn = {
      ...(existingTurn as AssistantTurn),
      activity: nextStreamState.activity,
      status: nextStreamState.activity.isStreaming
        ? "streaming"
        : nextStreamState.activity.error
          ? "error"
          : "complete",
    }

    set({
      turnById: { ...state.turnById, [turnId]: updatedTurn },
      isStreaming: nextStreamState.activity.isStreaming ?? false,
      _streamState: nextStreamState,
    })
  },

  handleStreamEnded: (turnId, reason, payload) => {
    const state = get()

    // Stream switch: new user+assistant turns created by interjection
    if (reason === "stream_switch") {
      const newUserTurn = payload.userTurn as BackendTurn | undefined
      const newAssistantTurn = payload.newAssistantTurnId
        ? (payload.assistantTurn as BackendTurn | undefined)
        : undefined

      if (newUserTurn && newAssistantTurn) {
        const { turnIds: incomingIds, turnById: incomingById } =
          normalizeTurns([newUserTurn, newAssistantTurn])

        const streamState = createInitialState(newAssistantTurn.id)

        set((s) => ({
          turnIds: mergeTurnIds([...s.turnIds, ...incomingIds]),
          turnById: { ...s.turnById, ...incomingById },
          activeStreamTurnId: newAssistantTurn.id,
          isStreaming: true,
          _streamState: streamState,
        }))
        return
      }
    }

    // Normal end — clear streaming state
    if (state.activeStreamTurnId === turnId) {
      set({
        activeStreamTurnId: null,
        isStreaming: false,
        _streamState: null,
      })
    }
  },

  // -----------------------------------------------------------------------
  // History operations
  // -----------------------------------------------------------------------

  switchSibling: async (targetTurnId: string) => {
    const state = get()
    if (!state.threadId) return

    const threadId = state.threadId
    set({ loadStatus: "loading", error: null })

    try {
      const page = await api.turns.paginate(threadId, {
        fromTurnId: targetTurnId,
        direction: "both",
        limit: 100,
      })

      if (get().threadId !== threadId) return

      const { turnIds, turnById } = normalizeTurns(page.turns)

      set((s) => ({
        turnIds,
        // Merge to prevent flash — old turns stay in memory briefly
        turnById: { ...s.turnById, ...turnById },
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: page.hasMoreAfter,
        loadStatus: "idle",
      }))
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return
      set({
        error: getErrorMessage(error, "Failed to navigate"),
        loadStatus: "error",
      })
    }
  },

  editTurn: async (turnId: string, newText: string) => {
    const state = get()
    if (!state.threadId) return undefined

    const originalTurn = state.turnById[turnId]
    if (!originalTurn) return undefined

    // Edit creates a sibling at the same parent
    const prevTurnId = originalTurn.parentId

    try {
      const result = await api.turns.send(newText, {
        threadId: state.threadId,
        prevTurnId,
      })

      // Navigate to the new branch
      await get().switchSibling(result.assistantTurn.id)

      return { assistantTurnId: result.assistantTurn.id }
    } catch (error) {
      set({
        error: getErrorMessage(error, "Failed to edit turn"),
      })
      return undefined
    }
  },

  regenerateTurn: async (assistantTurnId: string) => {
    const state = get()
    if (!state.threadId) return undefined

    const assistantTurn = state.turnById[assistantTurnId]
    if (!assistantTurn || assistantTurn.role !== "assistant") return undefined

    // Find the parent user turn
    const userTurnId = assistantTurn.parentId
    if (!userTurnId) return undefined

    const userTurn = state.turnById[userTurnId]
    if (!userTurn || userTurn.role !== "user") return undefined

    // Extract text from user turn blocks
    const textContent = userTurn.blocks
      .filter((b) => b.blockType === "text")
      .map((b) => b.textContent ?? "")
      .join("")

    try {
      const result = await api.turns.send(textContent, {
        threadId: state.threadId,
        prevTurnId: userTurn.parentId,
      })

      // Navigate to the new branch
      await get().switchSibling(result.userTurn.id)

      return { assistantTurnId: result.assistantTurn.id }
    } catch (error) {
      set({
        error: getErrorMessage(error, "Failed to regenerate"),
      })
      return undefined
    }
  },

  // -----------------------------------------------------------------------
  // Interrupt
  // -----------------------------------------------------------------------

  interruptStream: async () => {
    const state = get()
    const turnId = state.activeStreamTurnId
    if (!turnId) return

    try {
      await api.turns.interrupt(turnId)

      // Refresh the turn to get final state
      const refreshed = await api.turns.getBlocks(turnId)
      const refreshedTurn = mapTurnToViewModel(refreshed)

      set((s) => ({
        turnById: { ...s.turnById, [turnId]: refreshedTurn },
        activeStreamTurnId: null,
        isStreaming: false,
        _streamState: null,
      }))
    } catch (error) {
      set({
        error: getErrorMessage(error, "Failed to interrupt"),
        activeStreamTurnId: null,
        isStreaming: false,
        _streamState: null,
      })
    }
  },

  // -----------------------------------------------------------------------
  // Pagination
  // -----------------------------------------------------------------------

  paginateBefore: async () => {
    const state = get()
    if (!state.threadId || state.turnIds.length === 0) return

    const topId = state.turnIds[0]
    if (!topId) return

    const threadId = state.threadId

    try {
      const page = await api.turns.paginate(threadId, {
        fromTurnId: topId,
        direction: "before",
        limit: 100,
      })

      if (get().threadId !== threadId) return

      const { turnIds: incomingIds, turnById: incomingById } = normalizeTurns(
        page.turns,
      )

      set((s) => ({
        turnIds: mergeTurnIds([...incomingIds, ...s.turnIds]),
        turnById: { ...s.turnById, ...incomingById },
        hasMoreBefore: page.hasMoreBefore,
      }))
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return
      set({
        error: getErrorMessage(error, "Failed to load older messages"),
      })
    }
  },

  paginateAfter: async () => {
    const state = get()
    if (!state.threadId || state.turnIds.length === 0) return

    const bottomId = state.turnIds[state.turnIds.length - 1]
    if (!bottomId) return

    const threadId = state.threadId

    try {
      const page = await api.turns.paginate(threadId, {
        fromTurnId: bottomId,
        direction: "after",
        limit: 100,
      })

      if (get().threadId !== threadId) return

      const { turnIds: incomingIds, turnById: incomingById } = normalizeTurns(
        page.turns,
      )

      set((s) => ({
        turnIds: mergeTurnIds([...s.turnIds, ...incomingIds]),
        turnById: { ...s.turnById, ...incomingById },
        hasMoreAfter: page.hasMoreAfter,
      }))
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return
      set({
        error: getErrorMessage(error, "Failed to load newer messages"),
      })
    }
  },

  // -----------------------------------------------------------------------
  // Error
  // -----------------------------------------------------------------------

  clearError: () => set({ error: null }),
}))
