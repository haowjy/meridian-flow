/**
 * useStreamStore — Per-stream streaming state registry.
 *
 * Extracted from useThreadStore (SRP) to support concurrent streams across
 * threads. Keyed by streamId (turnId), each entry tracks the SSE endpoint
 * and current block metadata.
 *
 * With a backend limit of ~3 concurrent streams, Object.values().find() is
 * negligible cost.
 */

import { create } from "zustand";
import { useThreadStore } from "./useThreadStore";
import type { BlockType } from "@/features/threads/types";

export interface StreamEntry {
  streamId: string; // turnId (or future: subagent ID, etc.)
  threadId: string; // which thread this belongs to
  url: string; // SSE endpoint
  blockIndex: number | null;
  blockType: BlockType | null;
}

interface StreamStore {
  streams: Record<string, StreamEntry>;

  // Actions
  registerStream(streamId: string, threadId: string, url: string): void;
  removeStream(streamId: string): void;
  removeStreamsByThread(threadId: string): void;
  setBlockInfo(
    streamId: string,
    blockIndex: number | null,
    blockType: BlockType | null,
  ): void;
}

export const useStreamStore = create<StreamStore>()((set) => ({
  streams: {},

  registerStream: (streamId, threadId, url) => {
    set((state) => ({
      streams: {
        ...state.streams,
        [streamId]: {
          streamId,
          threadId,
          url,
          blockIndex: null,
          blockType: null,
        },
      },
    }));
  },

  removeStream: (streamId) => {
    set((state) => {
      const next: Record<string, StreamEntry> = {};
      for (const [id, entry] of Object.entries(state.streams)) {
        if (id !== streamId) {
          next[id] = entry;
        }
      }
      return { streams: next };
    });
  },

  removeStreamsByThread: (threadId) => {
    set((state) => {
      const next: Record<string, StreamEntry> = {};
      for (const [id, entry] of Object.entries(state.streams)) {
        if (entry.threadId !== threadId) {
          next[id] = entry;
        }
      }
      return { streams: next };
    });
  },

  setBlockInfo: (streamId, blockIndex, blockType) => {
    set((state) => {
      const entry = state.streams[streamId];
      if (!entry) return {};
      return {
        streams: {
          ...state.streams,
          [streamId]: { ...entry, blockIndex, blockType },
        },
      };
    });
  },
}));

// =============================================================================
// CONVENIENCE HOOKS
// =============================================================================

/**
 * Get the primary stream entry for a thread. Returns null if no active stream.
 */
export function useStreamForThread(
  threadId: string | null,
): StreamEntry | null {
  return useStreamStore((state) => {
    if (!threadId) return null;
    return (
      Object.values(state.streams).find((e) => e.threadId === threadId) ?? null
    );
  });
}

/**
 * Shorthand: get streaming state shaped like the old flat fields, scoped to the
 * current thread. Minimizes migration burden for consumer components.
 */
export function useCurrentThreadStream(): {
  streamingTurnId: string | null;
  streamingUrl: string | null;
  streamingBlockIndex: number | null;
  streamingBlockType: BlockType | null;
} {
  const threadId = useThreadStore((s) => s.threadId);
  const entry = useStreamForThread(threadId);

  if (!entry) {
    return {
      streamingTurnId: null,
      streamingUrl: null,
      streamingBlockIndex: null,
      streamingBlockType: null,
    };
  }

  return {
    streamingTurnId: entry.streamId,
    streamingUrl: entry.url,
    streamingBlockIndex: entry.blockIndex,
    streamingBlockType: entry.blockType,
  };
}
