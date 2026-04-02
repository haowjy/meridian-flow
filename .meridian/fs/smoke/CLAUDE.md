# Smoke Tests

Manual and semi-manual smoke tests for features that need real running servers, timing-dependent behavior, or multi-step flows that automated tests can't easily cover.

## Structure

Each feature area has its own directory with:
- `CLAUDE.md` — agent instructions for that area
- `README.md` — human-readable overview
- Individual test files describing scenarios, reproduction steps, and expected behavior

## Available Features

| Feature | Location | What it covers |
|---------|----------|---------------|
| WebSocket | `websocket/` | Thread WS streaming, Doc WS Yjs sync, framework edge cases |

## When to Use

Run smoke tests:
- After implementing a feature that touches real-time behavior
- After fixing a bug found by a reviewer (verify the fix end-to-end)
- Before marking a work item as done
- When integration tests pass but you want to verify against a real server

## How to Run (Agents)

**Parallelize smoke tests.** Each test file is independent — there are no ordering dependencies between them. When smoke testing a feature area:

1. Read the area's `CLAUDE.md` to identify which test files are relevant to what changed
2. **Spawn one smoke-tester per test file** (or group of 2-3 related files) — don't bundle all tests into one sequential agent
3. Each spawn gets `--sandbox full-access` (smoke tests bind ports and start servers)
4. Collect results and report failures

Example: after modifying the wsutil framework, you'd spawn 4 parallel smoke-testers:
- One for `framework/auth-and-heartbeat.md`
- One for `framework/rate-limiting.md`
- One for `edge-cases/backpressure.md` + `edge-cases/subscription-slot-exhaustion.md`
- One for `edge-cases/reconnect-catchup.md` + `edge-cases/reconnect-stale-epoch.md`

**Never run all smoke tests sequentially in one agent.** That's slow and wasteful. The test files are designed to be self-contained — each describes its own setup, reproduction steps, and expected behavior. An agent reading one file has everything it needs.

## Toy Client

`websocket/client/ws-client.mjs` is a Node.js WebSocket client with flags for each edge case scenario. See `websocket/CLAUDE.md` for usage.
