import { useEffect, useRef, useCallback } from 'react'

interface BufferConfig {
  flushInterval?: number // default: 50ms
  onFlush: (blockIndex: number, blockType: string, content: string) => void
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
  // Buffers are keyed by `${blockType}:${blockIndex}` so interleaved lifecycles
  // (e.g. tool starts before TEXT_MESSAGE_END) don't mis-route pending text to the
  // "current" block.
  const buffersRef = useRef<Record<string, string>>({})
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // SOLID D: Stable reference to callback - avoids recreating derived callbacks
  // when onFlush changes, which would cause SSE reconnects in dependent effects.
  const onFlushRef = useRef(onFlush)
  useEffect(() => {
    onFlushRef.current = onFlush
  }, [onFlush])

  const flushAll = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const entries = Object.entries(buffersRef.current)
    if (entries.length === 0) return

    for (const [key, content] of entries) {
      if (!content) continue
      const [blockType, blockIndexStr] = key.split(':')
      const blockIndex = Number(blockIndexStr)
      if (!Number.isFinite(blockIndex)) continue
      onFlushRef.current(blockIndex, blockType ?? 'text', content)
    }

    buffersRef.current = {}
  }, []) // Empty deps - stable forever

  const append = useCallback(
    (blockIndex: number, blockType: string, delta: string) => {
      if (!delta || !Number.isFinite(blockIndex)) return

      const key = `${blockType}:${blockIndex}`
      buffersRef.current[key] = (buffersRef.current[key] ?? '') + delta

      // Schedule flush if not already scheduled
      if (!timerRef.current) {
        timerRef.current = setTimeout(flushAll, flushInterval)
      }
    },
    [flushAll, flushInterval] // flushInterval is primitive, flushAll is stable
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return { append, flush: flushAll }
}
