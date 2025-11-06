import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RetryScheduler, type SyncOp } from '@/core/lib/retry'

describe('RetryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a queued operation when nextAt is reached', async () => {
    let now = 0
    const clock = { now: () => now }
    const sync = vi.fn(async (op: SyncOp<string, string>) => op.payload.toUpperCase())
    const backoff = { nextDelayMs: (attempt: number) => 50 * attempt }
    const scheduler = new RetryScheduler<string, string, string>({ sync, clock, backoff, maxAttempts: 3, tickMs: 10 })

    scheduler.add({ id: 'd1', payload: 'hello' })
    scheduler.start()

    // Not yet time
    vi.advanceTimersByTime(20)
    expect(sync).toHaveBeenCalledTimes(0)

    // Advance logical clock to pass nextAt
    now = 60
    vi.advanceTimersByTime(20)

    // Let any microtasks resolve
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
  })

  it('retries up to maxAttempts, then calls onPermanentFailure', async () => {
    let now = 0
    const clock = { now: () => now }
    const sync = vi.fn(async () => {
      throw new Error('net')
    })
    const backoff = { nextDelayMs: () => 50 }
    const onPermanentFailure = vi.fn()
    const scheduler = new RetryScheduler<string, string, string>({ sync, clock, backoff, maxAttempts: 2, tickMs: 10 })

    scheduler.add({ id: 'd1', payload: 'x' }, { onPermanentFailure })
    scheduler.start()

    // attempt 1
    now = 60
    vi.advanceTimersByTime(20)
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1))

    // attempt 2
    now = 120
    vi.advanceTimersByTime(60)
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))

    // permanent failure called after exhausting attempts
    await vi.waitFor(() => expect(onPermanentFailure).toHaveBeenCalledTimes(1))
  })
})

