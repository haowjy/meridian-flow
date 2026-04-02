# Edge Case Smoke Tests

Tests for failure modes, race conditions, and recovery paths that are difficult to reproduce in automated tests. These require real running servers and careful timing.

Run these after modifying: wsutil backpressure/EndSub, reconnection logic, interjection forwarder, or gap recovery.

See `../CLAUDE.md` for setup and toy client usage.

## Tests

- `backpressure.md` — frozen client → queue overflow → gap → subscription terminated
- `reconnect-catchup.md` — disconnect → reconnect with epoch/lastSeq → replay missed events
- `reconnect-stale-epoch.md` — reconnect after server restart → gap → REST fallback
- `two-gap-livelock.md` — gap → subscribe → gap → stop (per-turnId tracking)
- `stream-switch-race.md` — interjection during drain window → forwarded to successor
- `missed-stream-switch.md` — disconnect during switch → REST discovery → successor_turn_id
- `subscription-slot-exhaustion.md` — 10 stream switches → verify EndSub frees slots
- `panic-recovery.md` — handler panic → connection survives
- `heartbeat-auth-revocation.md` — lose project access → connection torn down within 20s
