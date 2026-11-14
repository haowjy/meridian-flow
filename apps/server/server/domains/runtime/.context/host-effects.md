# Host effects

A write that a runtime commit owes the host (today: marking a message's uploads used) is a row
in `host_effects`, inserted in the runtime's transaction by `createHostEffectOutbox().record`
and delivered after it to the host's `HostEffects.handle` (`lib/runtime-host/host-effects.ts`).

- Delivery runs after the commit, at boot and every wake-sweep tick (the `host-effects` lane in
  `lib/app.ts`). Each row is locked (`FOR UPDATE SKIP LOCKED`) while its handler runs and
  deleted when it returns; no order is promised and a failing row holds back no other.
- A handler that throws leaves its row and adds to `attempts`; from
  `HOST_EFFECT_STUCK_ATTEMPTS` failures on, each failure logs `runtime.host_effects effect.stuck`.
- Delivery is at least once. A handler is repeatable, does all its work in one host
  transaction, and reads nothing about the thread: the payload carries what it needs.
- A new kind is a case in the host's handler and a `record` call in the transaction that owes it.
