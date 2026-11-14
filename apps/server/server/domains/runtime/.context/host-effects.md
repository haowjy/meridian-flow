# Host effects

A write that a runtime commit owes the host (today: marking a message's uploads used) is a row
in `host_effects`, inserted in the runtime's transaction by `createHostEffectOutbox().record`
and delivered after it to the host's `HostEffects.handle` (`lib/runtime-host/host-effects.ts`).

- One delivery loop runs per process. The after-commit hook, boot and the `host-effects` lane in
  `lib/app.ts` all call `deliver`; a call while the loop runs makes it go round once more, and
  two passes never overlap. The loop takes one due row at a time (`FOR UPDATE SKIP LOCKED`),
  holding that row's lock while its handler runs in the host's own transaction. So delivery holds
  at most two connections, and a second process skips a row the first holds. The scheduler's
  abort signal stops the loop between rows.
- A handler that throws leaves its row, adds to `attempts` and pushes `next_attempt_at` out
  (`hostEffectBackoffMs`: 5s doubling to 5 minutes); only due rows are taken, so a failing row
  costs one try per backoff, not one per send. It logs `runtime.host_effects effect.stuck` once,
  at `HOST_EFFECT_STUCK_ATTEMPTS` failures. No order is promised and a failing row holds back no other.
- Delivery is at least once. A handler is repeatable, does all its work in one host
  transaction, and reads nothing about the thread: the payload carries what it needs.
- A new kind is a case in the host's handler and a `record` call in the transaction that owes it.
