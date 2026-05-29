# Shared Infrastructure — `src/lib/`

## What Lives Here

Shared utilities and infrastructure consumed across seams. These are
not features — they are the plumbing.

| Module | File(s) | Responsibility |
|---|---|---|
| `cn()` | `utils.ts` | Single class-merge entrypoint: `clsx` + `tailwind-merge` |
| Timeline scrubber | `use-timeline-playback.ts` | Storybook helper hook for simulating real-time data playback |
| WS client library | `ws/` | Custom WebSocket infrastructure (5 files) |

### WS Client Library (`ws/`)

Four-lane envelope protocol: `control` (auth, subscribe, ping/pong),
`notify` (cache invalidation), `stream` (event, ended, gap), `error`.

| File | Responsibility |
|---|---|
| `protocol.ts` | Message types, envelope structure, type guards |
| `ws-client.ts` | Reconnect with exponential backoff, heartbeat, auth token refresh (~396 lines) |
| `doc-stream-client.ts` | Yjs binary frame routing, subscription management (~408 lines) |
| `notify-handler.ts` | Routes `notify` events → TanStack Query invalidation |
| `index.ts` | Public API barrel export |

## Local Rules

### `cn()` Is the Only Class-Merge Entrypoint

All component `className` composition goes through `cn()` from
`src/lib/utils.ts`. No direct `clsx` or `twMerge` calls outside this
utility. See `AGENTS.md` §Override Policy for where `twMerge` may be
called (component boundary only).

### WS Consumers Use the Envelope Lanes

All WebSocket communication goes through the 4-lane envelope protocol.
Features must not bypass the protocol — no raw WebSocket message
parsing in feature code. The `WsClient` and `DocStreamClient` classes
are the only WS entrypoints.

### Streaming Yield-Between-Chunks

Any stream consumer (activity stream, thread rendering, doc sync)
must follow the yield-between-chunks rule:

1. Batch incoming chunks
2. Yield to the main thread between batches
3. No synchronous reflow-reads after writes in the same task

This applies to `DocStreamClient` consumers, `WsClient` stream lane
handlers, and any `ReadableStream`-based data processing. See
`_docs/design/foundations/motion.md` §Streaming Text: Yield-Between-
Chunks Rule.

### Query Invalidation via Notify Handler

TanStack Query cache invalidation is driven by WebSocket `notify`
events routed through `notify-handler.ts`. Features that own query
keys register their invalidation handlers there. No polling-based
invalidation.

### Dexie Helpers

Dexie 4 is installed but not yet integrated with a helper layer.
When it is:
- All IndexedDB access goes through Dexie (no raw `indexedDB` API)
- Schema definitions are versioned
- Helpers live in `src/lib/` (not scattered across features)

## Design Spec Pointers

| Concern | Canonical doc |
|---|---|
| Streaming yield rules, INP budget | `_docs/design/foundations/motion.md` |
| Token discipline (what may remain raw vs. must be a token) | `_docs/design/foundations/tokens.md` §Token Discipline: Raw Value Whitelist |
| Override policy (where `twMerge` is called) | `_docs/design/components.md` §Override Policy |
