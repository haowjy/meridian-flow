"use client"

import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@/core/stores/useChatStore'

/**
 * Feature-level hook for loading turns for a given chat.
 *
 * For now this wraps useChatStore.loadTurns(chatId, signal) and exposes
 * a turn-view slice + loading state. Later it will operate directly on
 * the richer Turn model (with blocks/metadata).
 */
export function useTurnsForChat(chatId: string | null) {
  const { turns, isLoadingTurns, error, loadTurns } = useChatStore(useShallow((s) => ({
    turns: s.turns,
    isLoadingTurns: s.isLoadingTurns,
    error: s.error,
    loadTurns: s.loadTurns,
  })))

  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!chatId) return

    // Cancel any in-flight request before starting a new one
    if (abortRef.current) {
      abortRef.current.abort()
    }

    const controller = new AbortController()
    abortRef.current = controller

    void loadTurns(chatId, controller.signal)

    return () => {
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  // Filter turns client-side to prevent showing stale data during chat transitions
  // (store may briefly contain turns from previous chatId before new data loads)
  const scoped = chatId ? turns.filter((t) => t.chatId === chatId) : []

  return {
    turns: scoped,
    isLoading: isLoadingTurns,
    error,
  }
}
