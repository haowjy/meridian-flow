"use client"

import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@/core/stores/useChatStore'
import { Chat } from '@/features/chats/types'

type LoadStatus = 'idle' | 'loading' | 'success' | 'error'

interface UseChatsForProjectResult {
  chats: Chat[]
  status: LoadStatus
  isLoading: boolean
  error: string | null
}

/**
 * Feature-level hook for loading chats for a given project.
 *
 * Responsibilities:
 * - Orchestrate calling useChatStore.loadChats(projectId, signal)
 * - Manage AbortController lifecycle when projectId changes or component unmounts
 *
 * It does NOT:
 * - Decide which chat is active (owned by useUIStore)
 * - Create / rename / delete chats (call store methods directly where needed)
 */
export function useChatsForProject(projectId: string): UseChatsForProjectResult {
  const { chats, statusChats, isLoadingChats, error, loadChats } = useChatStore(useShallow((s) => ({
    chats: s.chats,
    statusChats: s.statusChats,
    isLoadingChats: s.isLoadingChats,
    error: s.error,
    loadChats: s.loadChats,
  })))

  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!projectId) return

    // Cancel any in-flight request before starting a new one to prevent race condition:
    // If projectId changes rapidly, previous request should not overwrite newer data
    if (abortRef.current) {
      abortRef.current.abort()
    }

    const abortController = new AbortController()
    abortRef.current = abortController

    void loadChats(projectId, abortController.signal)

    return () => {
      abortController.abort()
    }
    // loadChats is stable from Zustand; we intentionally avoid adding it
    // as a dependency to prevent effect churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return {
    chats,
    status: statusChats,
    isLoading: isLoadingChats,
    error,
  }
}

