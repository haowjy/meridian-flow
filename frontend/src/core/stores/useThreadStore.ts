import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  Thread,
  Turn,
  type TurnBlock,
  type BlockType,
  type ThreadRequestOptions,
  type ContentBlock,
} from "@/features/threads/types";

import {
  DEFAULT_THREAD_REQUEST_OPTIONS,
  requestParamsToOptions,
} from "@/features/threads/types";
import { api } from "@/core/lib/api";
import { getErrorMessageWithFallback } from "@/core/lib/errors";
import { makeLogger } from "@/core/lib/logger";
import { getTurnBlockIdentity } from "@/features/threads/utils/blockIdentity";
import { turnToContentBlocks } from "@/features/threads/utils/turnHelpers";

// Stream-end coordination for cancel flow.
// Stored outside Zustand since it contains non-serializable data (functions, timers).
// Uses Set<resolver> to allow multiple waiters per turnId without orphaned promises.
type StreamEndWaiter = {
  resolvers: Set<() => void>;
  timeoutId: ReturnType<typeof setTimeout>;
};
const streamEndWaiters = new Map<string, StreamEndWaiter>();

/**
 * TODO(DEXIE CACHING) - High Priority Follow-up:
 * Implement windowed Dexie caching for thread turns (last ~100 items) and re-enable
 * cache policies for fast warm loads and offline fallback. Current MVP intentionally
 * bypasses Dexie for turns to simplify server-driven pagination integration.
 * - Cache shape: messages table keyed by threadId with createdAt index
 * - Strategy: windowed write-through on paginate/send; hydrate on openThread
 * - Ensure no duplication and preserve chronological order on merges
 */
type LoadStatus = "idle" | "loading" | "success" | "error";

interface ThreadStore {
  threads: Thread[];
  /** Project ID for the currently cached threads (enables stale-while-revalidate) */
  threadsProjectId: string | null;
  /** Ordered IDs for the currently loaded turn window (active thread only). */
  turnIds: string[];
  /** Normalized turn entities for the active thread window. */
  turnById: Record<string, Turn>;
  threadId: string | null;
  currentTurnId: string | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  statusThreads: LoadStatus;
  isFetchingThreads: boolean;
  isLoadingTurns: boolean;
  /** Flag for sibling navigation (disables buttons but doesn't trigger loading UI) */
  isSwitchingSibling: boolean;
  error: string | null;
  navigationAbortController: AbortController | null;

  // Computed getter for backwards compatibility
  isLoadingThreads: boolean;

  // Streaming state for the currently active assistant turn (at most one)
  streamingTurnId: string | null;
  streamingUrl: string | null;
  streamingBlockIndex: number | null;
  streamingBlockType: BlockType | null;

  // Interjection state (user message submitted while streaming)
  interjectionContent: string | null;

  loadThreads: (projectId: string, signal?: AbortSignal) => Promise<void>;
  // Legacy shape retained; internally calls openThread
  loadTurns: (threadId: string, signal?: AbortSignal) => Promise<void>;
  createThread: (projectId: string, title: string) => Promise<Thread>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  createTurn: (
    threadId: string,
    blocks: ContentBlock[],
    options: ThreadRequestOptions,
  ) => Promise<void>;
  // Cold-start: creates a new thread atomically with the first turn
  startNewThread: (
    projectId: string,
    blocks: ContentBlock[],
    options: ThreadRequestOptions,
  ) => Promise<Thread>;
  deleteThread: (threadId: string) => Promise<void>;

  // Streaming helpers
  appendStreamingTextDelta: (
    turnId: string,
    blockIndex: number,
    blockType: string,
    delta: string,
  ) => void;
  setStreamingBlockContent: (
    turnId: string,
    blockIndex: number,
    blockType: string,
    content: Record<string, unknown>,
  ) => void;
  clearStreamingStream: () => void;
  setStreamingBlockInfo: (
    blockIndex: number | null,
    blockType: BlockType | null,
  ) => void;
  setCurrentTurnId: (turnId: string) => void;

  interruptStreamingTurn: () => Promise<void>;

  // Stream-end coordination (used by cancel flow)
  waitForStreamEnd: (turnId: string, timeoutMs?: number) => Promise<void>;
  notifyStreamEnded: (turnId: string) => void;

  // Interjection support (submit message while streaming)
  setInterjectionContent: (content: string | null) => void;
  submitInterjection: (
    turnId: string,
    content: string,
    mode?: "append" | "replace",
  ) => Promise<void>;
  clearInterjection: (turnId: string) => Promise<void>;
  applyStreamSwitch: (
    prevTurnId: string,
    userTurn: Turn,
    assistantTurn: Turn,
    streamUrl: string,
  ) => void;

  // Pagination & navigation (server-driven)
  openThread: (
    threadId: string,
    initialTurnId?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  paginateBefore: (signal?: AbortSignal) => Promise<void>;
  paginateAfter: (signal?: AbortSignal) => Promise<void>;
  switchSibling: (
    threadId: string,
    targetTurnId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  editTurn: (
    threadId: string,
    parentTurnId: string | undefined,
    blocks: ContentBlock[],
    options?: ThreadRequestOptions,
  ) => Promise<void>;
  regenerateTurn: (threadId: string, parentTurnId: string) => Promise<void>;
  refreshTurn: (threadId: string, turnId: string) => Promise<void>;
  clearError: () => void;
}

/**
 * Helper to detect if any assistant turn is actively streaming.
 * Returns streaming state or null values if no streaming turn found.
 */
const detectStreamingState = (
  turnIds: string[],
  turnById: Record<string, Turn>,
) => {
  // Find any assistant turn that's actively streaming
  for (const id of turnIds) {
    const t = turnById[id];
    if (!t) continue;
    if (
      (t.status === "streaming" || t.status === "waiting_subagents") &&
      t.role === "assistant"
    ) {
      return {
        streamingTurnId: t.id,
        streamingUrl: `/api/turns/${t.id}/stream`,
      };
    }
  }

  return {
    streamingTurnId: null,
    streamingUrl: null,
  };
};

/**
 * Helper to update last_viewed_turn_id bookmark.
 * Logs errors but doesn't throw - bookmark updates are non-critical.
 */
const updateLastViewedTurnBookmark = async (
  threadId: string,
  turnId: string,
) => {
  try {
    await api.threads.updateLastViewedTurn(threadId, turnId);
  } catch (err) {
    const log = makeLogger("thread-store");
    log.warn("Failed to update last_viewed_turn_id", {
      threadId,
      turnId,
      error: err,
    });
  }
};

function reconcileTurnBlocks(
  prevBlocks: TurnBlock[],
  nextBlocks: TurnBlock[],
): TurnBlock[] {
  if (nextBlocks.length === 0) return prevBlocks;

  const prevByIdentity = new Map<string, TurnBlock>();
  for (const b of prevBlocks) {
    prevByIdentity.set(getTurnBlockIdentity(b), b);
  }

  return nextBlocks.map((next) => {
    const prev = prevByIdentity.get(getTurnBlockIdentity(next));
    if (!prev) return next;

    // Preserve object identity when nothing relevant changed.
    // This reduces unnecessary rerenders/flicker for memoized block renderers.
    const prevContent = prev.content;
    const nextContent = next.content;
    const contentEqual =
      prevContent === nextContent ||
      (prevContent == null && nextContent == null);

    if (
      prev.blockType === next.blockType &&
      prev.sequence === next.sequence &&
      prev.textContent === next.textContent &&
      prev.status === next.status &&
      contentEqual
    ) {
      return prev;
    }

    return next;
  });
}

function normalizeTurnWindow(turns: Turn[]): {
  turnIds: string[];
  turnById: Record<string, Turn>;
} {
  const turnById: Record<string, Turn> = {};
  const turnIds: string[] = [];
  const seen = new Set<string>();

  for (const t of turns) {
    turnById[t.id] = t;
    if (!seen.has(t.id)) {
      seen.add(t.id);
      turnIds.push(t.id);
    }
  }

  return { turnIds, turnById };
}

function mergeTurnIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export const useThreadStore = create<ThreadStore>()(
  persist(
    (set, get) => ({
      threads: [],
      threadsProjectId: null,
      turnIds: [],
      turnById: {},
      threadId: null,
      currentTurnId: null,
      hasMoreBefore: false,
      hasMoreAfter: false,
      statusThreads: "idle" as LoadStatus,
      isFetchingThreads: false,
      isLoadingTurns: false,
      isSwitchingSibling: false,
      error: null,
      navigationAbortController: null,
      streamingTurnId: null,
      streamingUrl: null,
      streamingBlockIndex: null,
      streamingBlockType: null,
      interjectionContent: null,

      // Computed getter for backwards compatibility
      get isLoadingThreads() {
        return get().statusThreads === "loading";
      },

      refreshTurn: async (threadId: string, turnId: string) => {
        set({ error: null });
        try {
          const {
            blocks,
            error: turnError,
            status,
          } = await api.turns.getBlocks(turnId);
          set((state) => {
            const existing = state.turnById[turnId];
            if (!existing) return {};

            const nextTurn: Turn = {
              ...existing,
              blocks: reconcileTurnBlocks(existing.blocks, blocks),
              error: turnError,
              status,
            };

            return { turnById: { ...state.turnById, [turnId]: nextTurn } };
          });
        } catch (error) {
          set({
            error: getErrorMessageWithFallback(error, "Failed to refresh turn"),
          });
        }
      },

      loadThreads: async (projectId: string, signal?: AbortSignal) => {
        const state = get();
        // Stale-while-revalidate: show cached data immediately if same project
        const hasCachedData =
          state.threads.length > 0 && state.threadsProjectId === projectId;

        if (!hasCachedData) {
          // No cache or different project: show loading state
          set({
            statusThreads: "loading",
            isFetchingThreads: true,
            error: null,
            threadsProjectId: projectId,
          });
        } else {
          // Has cache for same project: keep showing cached data, fetch in background
          set({ isFetchingThreads: true, error: null });
        }

        try {
          const data = await api.threads.list(projectId, { signal });
          set({
            threads: data,
            statusThreads: "success",
            isFetchingThreads: false,
            threadsProjectId: projectId,
          });
        } catch (error) {
          // Handle AbortError silently
          if (error instanceof Error && error.name === "AbortError") {
            set({ isFetchingThreads: false });
            return;
          }

          const message = getErrorMessageWithFallback(
            error,
            "Failed to load threads",
          );
          // On error with cached data for same project, keep showing cached data
          const hasData =
            get().threads.length > 0 && get().threadsProjectId === projectId;
          set({
            error: message,
            statusThreads: hasData ? "success" : "error",
            isFetchingThreads: false,
          });
        }
      },

      loadTurns: async (threadId: string, signal?: AbortSignal) => {
        // Fetch thread to get lastViewedTurnId for auto-scroll
        const thread = await api.threads.get(threadId);
        // Delegate to openThread with lastViewedTurnId as initial turn
        await get().openThread(
          threadId,
          thread.lastViewedTurnId ?? undefined,
          signal,
        );
      },

      createThread: async (projectId: string, title: string) => {
        set({ error: null });
        try {
          const thread = await api.threads.create(projectId, title);

          set((state) => ({
            threads: [...state.threads, thread],
          }));
          return thread;
        } catch (error) {
          const message = getErrorMessageWithFallback(
            error,
            "Failed to create thread",
          );
          set({ error: message });
          throw error;
        }
      },

      renameThread: async (threadId: string, title: string) => {
        set({ error: null });
        try {
          const updated = await api.threads.update(threadId, title);

          set((state) => ({
            threads: state.threads.map((c) =>
              c.id === threadId ? updated : c,
            ),
          }));
        } catch (error) {
          set({
            error: getErrorMessageWithFallback(
              error,
              "Failed to rename thread",
            ),
          });
          throw error;
        }
      },

      createTurn: async (
        threadId: string,
        blocks: ContentBlock[],
        options: ThreadRequestOptions,
      ) => {
        // Skeleton - optimistic updates implemented in Phase 4 Task 4.7
        set({ error: null });
        try {
          // Determine prevTurnId from the last turn in the current list
          const state = get();
          const prevTurnId = state.turnIds[state.turnIds.length - 1] ?? null;

          // Derive plain text for the message param (legacy/interjection compat)
          const messageText = blocks
            .filter(
              (b): b is ContentBlock & { type: "text" } => b.type === "text",
            )
            .map((b) => b.text)
            .join("");

          const { userTurn, assistantTurn, streamUrl } = await api.turns.send(
            messageText,
            {
              threadId,
              prevTurnId,
              requestOptions: options,
              blocks,
            },
          );

          // Response contains both user's turn and assistant's turn (streaming handled via SSE)
          set((state) => {
            const incoming = [userTurn, assistantTurn];
            const { turnById: incomingById } = normalizeTurnWindow(incoming);
            return {
              turnIds: mergeTurnIds([
                ...state.turnIds,
                ...incoming.map((t) => t.id),
              ]),
              turnById: { ...state.turnById, ...incomingById },
              streamingTurnId: assistantTurn.id,
              streamingUrl: streamUrl,
            };
          });

          // Update bookmark to the new assistant turn
          await updateLastViewedTurnBookmark(threadId, assistantTurn.id);
        } catch (error) {
          set({
            error: getErrorMessageWithFallback(error, "Failed to send message"),
          });
          throw error;
        }
      },

      startNewThread: async (
        projectId: string,
        blocks: ContentBlock[],
        options: ThreadRequestOptions,
      ): Promise<Thread> => {
        // Cold-start: atomically create thread + first turn in one request
        set({ error: null });
        try {
          const messageText = blocks
            .filter(
              (b): b is ContentBlock & { type: "text" } => b.type === "text",
            )
            .map((b) => b.text)
            .join("");

          const { thread, userTurn, assistantTurn, streamUrl } =
            await api.turns.send(messageText, {
              projectId,
              requestOptions: options,
              blocks,
            });

          if (!thread) {
            throw new Error(
              "Expected new thread in response but received none",
            );
          }

          // Add the new thread and its turns to state
          set((state) => {
            const { turnIds, turnById } = normalizeTurnWindow([
              userTurn,
              assistantTurn,
            ]);
            return {
              threads: [thread, ...state.threads],
              threadId: thread.id,
              turnIds,
              turnById,
              currentTurnId: assistantTurn.id,
              streamingTurnId: assistantTurn.id,
              streamingUrl: streamUrl,
            };
          });

          return thread;
        } catch (error) {
          set({
            error: getErrorMessageWithFallback(
              error,
              "Failed to start new thread",
            ),
          });
          throw error;
        }
      },

      deleteThread: async (threadId: string) => {
        set({ error: null });
        try {
          await api.threads.delete(threadId);

          set((state) => {
            const isActive = state.threadId === threadId;
            return {
              threads: state.threads.filter((c) => c.id !== threadId),
              ...(isActive
                ? {
                    threadId: null,
                    currentTurnId: null,
                    turnIds: [],
                    turnById: {},
                    hasMoreBefore: false,
                    hasMoreAfter: false,
                    streamingTurnId: null,
                    streamingUrl: null,
                    streamingBlockIndex: null,
                    streamingBlockType: null,
                  }
                : {}),
            };
          });
        } catch (error) {
          set({
            error: getErrorMessageWithFallback(
              error,
              "Failed to delete thread",
            ),
          });
          throw error;
        }
      },

      interruptStreamingTurn: async () => {
        const log = makeLogger("thread-store");
        const state = get();
        const turnId = state.streamingTurnId;
        const threadId = state.threadId;

        if (!turnId) {
          return;
        }

        set({ error: null });
        log.debug("interruptStreamingTurn:start", { turnId, threadId });

        try {
          // 1. Start waiting BEFORE interrupt request (prevents missing fast closes)
          const streamEndPromise = state.waitForStreamEnd(turnId, 3000);

          // 2. Request interrupt from backend
          await api.turns.interrupt(turnId);

          // 3. Wait for SSE to actually end (or timeout)
          await streamEndPromise;
          log.debug("interruptStreamingTurn:streamEnded", { turnId });

          // 4. Clear local state (SSE hook may have already done this)
          get().clearStreamingStream();

          // 5. Refresh to get final state with partial blocks
          if (threadId) {
            await state.refreshTurn(threadId, turnId);
          }
        } catch (error) {
          set({
            error: getErrorMessageWithFallback(
              error,
              "Failed to interrupt streaming turn",
            ),
          });
        }
      },

      waitForStreamEnd: (turnId: string, timeoutMs = 3000): Promise<void> => {
        const log = makeLogger("thread-store");
        const existing = streamEndWaiters.get(turnId);

        if (existing) {
          // SOLID S: Single responsibility - just add to existing resolver set
          log.debug("waitForStreamEnd:existingWaiter", { turnId });
          return new Promise((resolve) => {
            existing.resolvers.add(resolve);
          });
        }

        // Create new waiter with resolver Set
        return new Promise((resolve) => {
          const resolvers = new Set<() => void>([resolve]);
          const timeoutId = setTimeout(() => {
            log.debug("waitForStreamEnd:timeout", { turnId, timeoutMs });
            streamEndWaiters.delete(turnId);
            resolvers.forEach((r) => r()); // Resolve all waiting promises
          }, timeoutMs);

          streamEndWaiters.set(turnId, { resolvers, timeoutId });
          log.debug("waitForStreamEnd:registered", { turnId, timeoutMs });
        });
      },

      notifyStreamEnded: (turnId: string) => {
        const log = makeLogger("thread-store");
        const waiter = streamEndWaiters.get(turnId);

        if (waiter) {
          log.debug("notifyStreamEnded:resolving", { turnId });
          clearTimeout(waiter.timeoutId);
          streamEndWaiters.delete(turnId); // Clean up BEFORE resolving
          waiter.resolvers.forEach((r) => r()); // Resolve all waiting promises
        } else {
          log.debug("notifyStreamEnded:noWaiter", { turnId });
        }
      },

      appendStreamingTextDelta: (
        turnId: string,
        blockIndex: number,
        blockType: string,
        delta: string,
      ) => {
        if (!delta) return;

        set((state) => {
          const turn = state.turnById[turnId];
          if (!turn) return {};

          const sequence = blockIndex;
          const existingIndex = turn.blocks.findIndex(
            (b) => b.sequence === sequence,
          );

          let nextBlocks: TurnBlock[];
          if (existingIndex === -1) {
            const newBlock: TurnBlock = {
              id: `${turn.id}:${sequence}`,
              turnId: turn.id,
              blockType:
                blockType as import("@/features/threads/types").BlockType,
              sequence,
              textContent: delta,
              content: undefined,
              createdAt: new Date(),
            };
            nextBlocks = [...turn.blocks, newBlock].sort(
              (a, b) => a.sequence - b.sequence,
            );
          } else {
            nextBlocks = turn.blocks.map((block, index) => {
              if (index !== existingIndex) return block;
              const text = block.textContent ?? "";
              return {
                ...block,
                blockType: (block.blockType ||
                  blockType) as import("@/features/threads/types").BlockType,
                textContent: text + delta,
              };
            });
          }

          const nextTurn: Turn = { ...turn, blocks: nextBlocks };
          return { turnById: { ...state.turnById, [turnId]: nextTurn } };
        });
      },

      setStreamingBlockContent: (
        turnId: string,
        blockIndex: number,
        blockType: string,
        content: Record<string, unknown>,
      ) => {
        set((state) => {
          const turn = state.turnById[turnId];
          if (!turn) return {};

          const sequence = blockIndex;
          const existingIndex = turn.blocks.findIndex(
            (b) => b.sequence === sequence,
          );

          let nextBlocks: TurnBlock[];
          if (existingIndex === -1) {
            const newBlock: TurnBlock = {
              id: `${turn.id}:${sequence}`,
              turnId: turn.id,
              blockType:
                blockType as import("@/features/threads/types").BlockType,
              sequence,
              textContent: undefined,
              content,
              createdAt: new Date(),
            };
            nextBlocks = [...turn.blocks, newBlock].sort(
              (a, b) => a.sequence - b.sequence,
            );
          } else {
            nextBlocks = turn.blocks.map((block, index) => {
              if (index !== existingIndex) return block;
              return {
                ...block,
                blockType: (block.blockType ||
                  blockType) as import("@/features/threads/types").BlockType,
                content,
              };
            });
          }

          const nextTurn: Turn = { ...turn, blocks: nextBlocks };
          return { turnById: { ...state.turnById, [turnId]: nextTurn } };
        });
      },

      clearStreamingStream: () => {
        set(() => ({
          streamingTurnId: null,
          streamingUrl: null,
          streamingBlockIndex: null,
          streamingBlockType: null,
          interjectionContent: null,
        }));
      },

      setStreamingBlockInfo: (
        blockIndex: number | null,
        blockType: BlockType | null,
      ) => {
        set(() => ({
          streamingBlockIndex: blockIndex,
          streamingBlockType: blockType,
        }));
      },

      setCurrentTurnId: (turnId: string) => {
        set(() => ({ currentTurnId: turnId }));
      },

      // Interjection support
      setInterjectionContent: (content: string | null) => {
        set(() => ({ interjectionContent: content }));
      },

      submitInterjection: async (
        turnId: string,
        content: string,
        mode: "append" | "replace" = "append",
      ) => {
        const log = makeLogger("thread-store");
        log.debug("submitInterjection:start", {
          turnId,
          mode,
          contentLength: content.length,
        });

        try {
          const response = await api.turns.submitInterjection(
            turnId,
            content,
            mode,
          );

          if (response.mode === "queued") {
            // Interjection was buffered - update local state
            set(() => ({ interjectionContent: response.content }));
            log.debug("submitInterjection:queued", {
              turnId,
              length: response.length,
            });
          } else if (response.mode === "created") {
            // Fallback path: turn wasn't streaming, new turns were created
            // Merge the new turns into state and update streaming
            const state = get();
            const { userTurn, assistantTurn, streamUrl } = response;
            if (userTurn && assistantTurn) {
              const { turnById: incomingById } = normalizeTurnWindow([
                userTurn as Turn,
                assistantTurn as Turn,
              ]);
              set({
                turnIds: mergeTurnIds([
                  ...state.turnIds,
                  userTurn.id,
                  assistantTurn.id,
                ]),
                turnById: { ...state.turnById, ...incomingById },
                streamingTurnId: assistantTurn.id,
                streamingUrl: streamUrl ?? null,
                interjectionContent: null,
              });
            }
            log.debug("submitInterjection:created", {
              userTurnId: userTurn?.id,
              assistantTurnId: assistantTurn?.id,
            });
          }
        } catch (error) {
          log.error("submitInterjection:error", error);
          set({
            error: getErrorMessageWithFallback(
              error,
              "Failed to submit interjection",
            ),
          });
          throw error;
        }
      },

      clearInterjection: async (turnId: string) => {
        const log = makeLogger("thread-store");
        log.debug("clearInterjection:start", { turnId });

        try {
          await api.turns.clearInterjection(turnId);
          set(() => ({ interjectionContent: null }));
          log.debug("clearInterjection:success", { turnId });
        } catch (error) {
          log.error("clearInterjection:error", error);
          // Don't throw - clearing is best-effort; user can retry
          // Still clear local state on error (server may have succeeded)
          set(() => ({ interjectionContent: null }));
        }
      },

      applyStreamSwitch: (
        prevTurnId: string,
        userTurn: Turn,
        assistantTurn: Turn,
        streamUrl: string,
      ) => {
        const log = makeLogger("thread-store");
        log.info("applyStreamSwitch", { prevTurnId, streamUrl });

        const state = get();

        // Turns are already converted from TurnDto by the SSE handler
        // No need for unsafe casts - they're properly typed Turn objects
        if (!userTurn || !assistantTurn) {
          log.error("applyStreamSwitch:missingTurns", {
            userTurn,
            assistantTurn,
          });
          return;
        }

        // Merge new turns into state
        const { turnById: incomingById } = normalizeTurnWindow([
          userTurn,
          assistantTurn,
        ]);

        // Update streaming to point to new assistant turn
        set({
          turnIds: mergeTurnIds([
            ...state.turnIds,
            userTurn.id,
            assistantTurn.id,
          ]),
          turnById: { ...state.turnById, ...incomingById },
          streamingTurnId: assistantTurn.id,
          streamingUrl: streamUrl,
          interjectionContent: null, // Clear - it's now persisted as userTurn
          currentTurnId: assistantTurn.id,
        });

        log.info("applyStreamSwitch:complete", {
          newUserTurnId: userTurn.id,
          newAssistantTurnId: assistantTurn.id,
          streamUrl,
        });
      },

      openThread: async (
        threadId: string,
        initialTurnId?: string,
        signal?: AbortSignal,
      ) => {
        const log = makeLogger("thread-store");
        log.debug("openThread:start", { threadId, initialTurnId });
        // Set threadId immediately so remounts can detect in-flight loads and avoid
        // redundant re-fetches that cause "progressive reload" UI.
        set({
          threadId,
          isLoadingTurns: true,
          error: null,
          turnIds: [],
          turnById: {},
        });
        try {
          const { turns, hasMoreBefore, hasMoreAfter } =
            await api.turns.paginate(threadId, {
              fromTurnId: initialTurnId,
              // Force both for initial load to guarantee context renders even if server defaults act unexpectedly.
              direction: "both",
              limit: 100,
              signal,
            });
          log.debug("openThread:response", {
            count: turns.length,
            hasMoreBefore,
            hasMoreAfter,
            first: turns[0]?.id,
            last: turns[turns.length - 1]?.id,
          });
          const { turnIds, turnById } = normalizeTurnWindow(turns);
          const lastTurnId =
            turnIds.length > 0 ? turnIds[turnIds.length - 1] : undefined;
          const nextCurrent = initialTurnId ?? (lastTurnId ? lastTurnId : null);
          set({
            threadId,
            turnIds,
            turnById,
            currentTurnId: nextCurrent,
            hasMoreBefore,
            hasMoreAfter,
            isLoadingTurns: false,
            ...detectStreamingState(turnIds, turnById),
          });
          log.debug("openThread:set", {
            threadId,
            currentTurnId: nextCurrent,
            total: turnIds.length,
          });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            set({ isLoadingTurns: false });
            log.debug("openThread:aborted", { threadId });
            return;
          }
          log.error("openThread:error", error);
          set({
            error: getErrorMessageWithFallback(error, "Failed to open thread"),
            isLoadingTurns: false,
          });
        }
      },

      paginateBefore: async (signal?: AbortSignal) => {
        const state = get();
        if (!state.threadId || state.turnIds.length === 0) return;
        const topId = state.turnIds[0];
        const top = topId ? state.turnById[topId] : undefined;
        if (!top) {
          set({ isLoadingTurns: false });
          return;
        }
        const log = makeLogger("thread-store");
        log.debug("paginateBefore:start", {
          threadId: state.threadId,
          fromTurnId: top.id,
        });
        set({ isLoadingTurns: true, error: null });
        try {
          const { turns, hasMoreBefore } = await api.turns.paginate(
            state.threadId,
            {
              fromTurnId: top.id,
              direction: "before",
              limit: 100,
              signal,
            },
          );
          log.debug("paginateBefore:response", {
            loaded: turns.length,
            hasMoreBefore,
            first: turns[0]?.id,
            last: turns[turns.length - 1]?.id,
          });
          // Prepend older turns (chronological order preserved by backend)
          const { turnIds: incomingIds, turnById: incomingById } =
            normalizeTurnWindow(turns);
          const mergedIds = mergeTurnIds([...incomingIds, ...state.turnIds]);
          const mergedById = { ...state.turnById, ...incomingById };
          set({
            turnIds: mergedIds,
            turnById: mergedById,
            hasMoreBefore,
            isLoadingTurns: false,
            ...detectStreamingState(mergedIds, mergedById),
          });
          log.debug("paginateBefore:set", { total: mergedIds.length });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            set({ isLoadingTurns: false });
            log.debug("paginateBefore:aborted");
            return;
          }
          log.error("paginateBefore:error", error);
          set({
            error: getErrorMessageWithFallback(
              error,
              "Failed to load older messages",
            ),
            isLoadingTurns: false,
          });
        }
      },

      paginateAfter: async (signal?: AbortSignal) => {
        const state = get();
        if (!state.threadId || state.turnIds.length === 0) return;
        const bottomId = state.turnIds[state.turnIds.length - 1];
        const bottom = bottomId ? state.turnById[bottomId] : undefined;
        if (!bottom) {
          set({ isLoadingTurns: false });
          return;
        }
        const log = makeLogger("thread-store");
        log.debug("paginateAfter:start", {
          threadId: state.threadId,
          fromTurnId: bottom.id,
        });
        set({ isLoadingTurns: true, error: null });
        try {
          const { turns, hasMoreAfter } = await api.turns.paginate(
            state.threadId,
            {
              fromTurnId: bottom.id,
              direction: "after",
              limit: 100,
              updateLastViewed: true, // Update bookmark when scrolling down
              signal,
            },
          );
          log.debug("paginateAfter:response", {
            loaded: turns.length,
            hasMoreAfter,
            first: turns[0]?.id,
            last: turns[turns.length - 1]?.id,
          });
          // Append newer turns
          const { turnIds: incomingIds, turnById: incomingById } =
            normalizeTurnWindow(turns);
          const mergedIds = mergeTurnIds([...state.turnIds, ...incomingIds]);
          const mergedById = { ...state.turnById, ...incomingById };
          set({
            turnIds: mergedIds,
            turnById: mergedById,
            hasMoreAfter,
            isLoadingTurns: false,
            ...detectStreamingState(mergedIds, mergedById),
          });
          log.debug("paginateAfter:set", { total: mergedIds.length });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            set({ isLoadingTurns: false });
            log.debug("paginateAfter:aborted");
            return;
          }
          log.error("paginateAfter:error", error);
          set({
            error: getErrorMessageWithFallback(
              error,
              "Failed to load newer messages",
            ),
            isLoadingTurns: false,
          });
        }
      },

      switchSibling: async (
        threadId: string,
        targetTurnId: string,
        signal?: AbortSignal,
      ) => {
        const log = makeLogger("thread-store");
        log.debug("switchSibling:start", { threadId, targetTurnId });

        const state = get();

        // Cancel previous request if it exists
        if (state.navigationAbortController) {
          state.navigationAbortController.abort();
        }

        const controller = new AbortController();
        // Use isSwitchingSibling instead of isLoadingTurns to avoid skeleton UI during sibling nav
        set({
          navigationAbortController: controller,
          isSwitchingSibling: true,
          error: null,
        });

        try {
          const { turns, hasMoreBefore, hasMoreAfter } =
            await api.turns.paginate(threadId, {
              fromTurnId: targetTurnId,
              direction: "both",
              limit: 100,
              updateLastViewed: true, // Explicit bookmarking on sibling switch
              signal: controller.signal ?? signal,
            });
          log.debug("switchSibling:response", {
            count: turns.length,
            hasMoreBefore,
            hasMoreAfter,
            first: turns[0]?.id,
            last: turns[turns.length - 1]?.id,
          });
          const { turnIds, turnById } = normalizeTurnWindow(turns);

          // Only update if not aborted
          if (!controller.signal.aborted) {
            // Merge turnById instead of replacing to prevent brief undefined flash
            // during React reconciliation. Old turns remain in memory but won't render
            // (not in turnIds) and will be garbage collected when no longer referenced.
            set((state) => ({
              threadId,
              turnIds,
              turnById: { ...state.turnById, ...turnById },
              currentTurnId: targetTurnId,
              hasMoreBefore,
              hasMoreAfter,
              isSwitchingSibling: false,
              navigationAbortController: null, // Clear after success
              ...detectStreamingState(turnIds, turnById),
            }));
            log.debug("switchSibling:set", {
              threadId,
              currentTurnId: targetTurnId,
              total: turnIds.length,
            });
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            log.debug("switchSibling:aborted");
            return;
          }
          log.error("switchSibling:error", error);
          set({
            error: getErrorMessageWithFallback(error, "Failed to navigate"),
            isSwitchingSibling: false,
            navigationAbortController: null,
          });
        }
      },

      editTurn: async (
        threadId: string,
        turnId: string | undefined,
        blocks: ContentBlock[],
        options?: ThreadRequestOptions,
      ) => {
        set({ isLoadingTurns: true, error: null });
        try {
          // Find the original turn to get its prevTurnId
          const state = get();
          const originalTurn = turnId ? state.turnById[turnId] : undefined;
          const prevTurnId = originalTurn ? originalTurn.prevTurnId : null;

          const messageText = blocks
            .filter(
              (b): b is ContentBlock & { type: "text" } => b.type === "text",
            )
            .map((b) => b.text)
            .join("");

          // Call createTurn endpoint with the SAME prevTurnId as the original turn
          // This creates a sibling branch.
          // Use provided options or fall back to defaults
          const { assistantTurn } = await api.turns.send(messageText, {
            threadId,
            prevTurnId,
            requestOptions: options ?? DEFAULT_THREAD_REQUEST_OPTIONS,
            blocks,
          });

          // Navigate to the new branch (the assistant turn leaf)
          // This ensures pagination includes the full thread context
          await get().switchSibling(threadId, assistantTurn.id);
          set({ isLoadingTurns: false });
        } catch (error) {
          set({
            error: getErrorMessageWithFallback(error, "Failed to edit turn"),
            isLoadingTurns: false,
          });
        }
      },

      regenerateTurn: async (threadId: string, assistantTurnId: string) => {
        set({ isLoadingTurns: true, error: null });
        try {
          const state = get();
          const assistantTurn = state.turnById[assistantTurnId];

          if (!assistantTurn) {
            throw new Error("Assistant turn not found");
          }

          // Find the preceding user turn
          const userTurnId = assistantTurn.prevTurnId;
          const userTurn = userTurnId ? state.turnById[userTurnId] : undefined;

          if (!userTurn) {
            throw new Error("Parent user turn not found for regeneration");
          }

          // Rebuild ordered content blocks from the user turn (preserves references)
          const userBlocks = turnToContentBlocks(userTurn);
          const userMessageText = userBlocks
            .filter(
              (b): b is ContentBlock & { type: "text" } => b.type === "text",
            )
            .map((b) => b.text)
            .join("");

          // Use the original assistant turn's request params for regeneration
          // This preserves the model, provider, thinking level, etc.
          const requestOptions = requestParamsToOptions(
            assistantTurn.requestParams,
          );

          // Re-send the user's content to create a new sibling response
          const { userTurn: newUserTurn } = await api.turns.send(
            userMessageText,
            {
              threadId,
              prevTurnId: userTurn.prevTurnId,
              requestOptions,
              blocks: userBlocks,
            },
          );

          // Navigate to the new branch
          await get().switchSibling(threadId, newUserTurn.id);
          set({ isLoadingTurns: false });
        } catch (error) {
          set({
            error: getErrorMessageWithFallback(error, "Failed to regenerate"),
            isLoadingTurns: false,
          });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: "thread-store",
      // For MVP we bypass Dexie for turns entirely.
      // TODO(DEXIE): Implement windowed Dexie caching for threads (last 100 turns) and re-enable cache policies here.
      partialize: () => ({}),
    },
  ),
);
