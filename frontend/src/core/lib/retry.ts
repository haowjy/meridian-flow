/**
 * RetryScheduler (draft)
 *
 * SRP: schedules transient retries for sync operations.
 * DIP: depends on injected sync function, clock, and backoff strategy.
 * OCP: swap backoff/clock without editing scheduler.
 */

export interface Clock {
  now(): number
}

export interface Backoff {
  // attempt starts at 1
  nextDelayMs(attempt: number): number
}

export interface SyncOp<ID = string, Payload = unknown> {
  id: ID
  payload: Payload
}

export interface RetryCallbacks<T> {
  onSuccess?: (result: T) => void
  onPermanentFailure?: (error: unknown) => void
  onAttempt?: (attempt: number) => void
}

export class RetryScheduler<ID = string, Payload = unknown, Result = unknown> {
  private readonly sync: (op: SyncOp<ID, Payload>) => Promise<Result>
  private readonly clock: Clock
  private readonly backoff: Backoff
  private readonly maxAttempts: number
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly intervalMs: number

  private queue = new Map<ID, { op: SyncOp<ID, Payload>; attempt: number; nextAt: number; cbs?: RetryCallbacks<Result> }>()
  private active = new Set<ID>()

  constructor(opts: { sync: (op: SyncOp<ID, Payload>) => Promise<Result>; clock?: Clock; backoff?: Backoff; maxAttempts?: number; tickMs?: number }) {
    this.sync = opts.sync
    this.clock = opts.clock ?? { now: () => Date.now() }
    // Default backoff: 5s base with ±20% jitter
    this.backoff = opts.backoff ?? {
      nextDelayMs: (attempt) => {
        const base = 5000 * Math.min(attempt, 6)
        const jitter = base * 0.2 * (Math.random() * 2 - 1)
        return Math.max(1000, Math.floor(base + jitter))
      },
    }
    this.maxAttempts = opts.maxAttempts ?? 3
    this.intervalMs = opts.tickMs ?? 1000
  }

  add(op: SyncOp<ID, Payload>, cbs?: RetryCallbacks<Result>) {
    this.queue.set(op.id, { op, attempt: 1, nextAt: this.clock.now() + this.backoff.nextDelayMs(1), cbs })
  }

  cancel(id: ID) {
    this.queue.delete(id)
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick() {
    const now = this.clock.now()
    for (const [id, entry] of this.queue) {
      if (entry.nextAt > now) continue
      if (this.active.has(id)) continue

      this.active.add(id)
      entry.cbs?.onAttempt?.(entry.attempt)
      try {
        const res = await this.sync(entry.op)
        this.queue.delete(id)
        entry.cbs?.onSuccess?.(res)
      } catch (err) {
        if (entry.attempt >= this.maxAttempts) {
          this.queue.delete(id)
          entry.cbs?.onPermanentFailure?.(err)
        } else {
          entry.attempt += 1
          entry.nextAt = now + this.backoff.nextDelayMs(entry.attempt)
        }
      } finally {
        this.active.delete(id)
      }
    }
  }

  snapshot() {
    return Array.from(this.queue.entries()).map(([id, e]) => ({ id, attempt: e.attempt, nextAt: e.nextAt }))
  }
}
