"use client"

import { useEffect, useRef, useCallback } from 'react'

interface BufferConfig {
  flushInterval?: number // default: 50ms
  onFlush: (content: string) => void
}

/**
 * Small helper hook that buffers streaming text deltas and flushes them
 * to a callback at a fixed interval. This reduces React re-renders while
 * still keeping the UI feeling responsive.
 */
export function useStreamingBuffer({
  flushInterval = 50,
  onFlush,
}: BufferConfig) {
  const bufferRef = useRef<string>('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const append = useCallback((delta: string) => {
    if (!delta) return

    bufferRef.current += delta

    // Schedule flush if not already scheduled
    if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        if (bufferRef.current) {
          onFlush(bufferRef.current)
          bufferRef.current = ''
        }
        timerRef.current = null
      }, flushInterval)
    }
  }, [flushInterval, onFlush])

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (bufferRef.current) {
      onFlush(bufferRef.current)
      bufferRef.current = ''
    }
  }, [onFlush])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return { append, flush }
}

