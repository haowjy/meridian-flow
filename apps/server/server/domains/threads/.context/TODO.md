# TODO

- `adapters/drizzle/thread-works-repository.ts` membership/rebind takes Work
  locks before its thread lock, while `adapters/drizzle/turn-repository.ts`
  takes the thread lock before touching primary Work activity. A rebind racing
  writer enqueue can deadlock; align the lock order across these operations.
  This inversion predates the inbox Work-notice migration. The route's short
  run claim does not exclude writer enqueue.
