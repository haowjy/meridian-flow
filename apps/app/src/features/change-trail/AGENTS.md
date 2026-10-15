# features/change-trail — shared trail evidence reads

Read policy for durable trail evidence; this directory is a seam, not a UI
surface. Swept elevation is live-session marker state, while trail evidence
retains the change's Before excerpt and navigation anchor.

- Receipt rows and peer-mark popovers read the same Before/After evidence.
  Trail evidence is read-only; receipt Undo/Redo is the sole AI reversal
  authority.
- Keep one cache entry per `(thread, trail)`. Settled evidence does not refetch
  on reopen; a shell-version bump or lost document access invalidates it.
- Prefetch while a mark is visible so disclosure does not fill after opening.

See [chat](../chat/AGENTS.md) for receipt consumers and the
[peer-mark surface](../editor/surfaces/peer-marks/AGENTS.md) for its host.

Consumers should request evidence through this seam rather than own another cache.

This keeps receipt and peer-mark evidence identical across their two hosts.

It is not a command or mutation owner.
