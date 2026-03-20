# Threads

Chat interface for AI interaction. CM6 input, streaming responses, tool calls.

## Scope

- CM6-based chat input (shared with editor via cm6-shared extensions)
- @mentions in chat input -- provided by F8 (@Mentions, Round 2b); not part of base Threads (F7). Base chat input works without mentions.
- Message send with optimistic rendering (fix current 1s delay)
- SSE streaming for AI responses via streamdown
- Tool call display (collapsible, shows tool name + result)
- Thread list per work item
- Quick switching between threads (LRU cached in-memory state)
- Scroll position memory per thread

## Data Architecture

- **Server-authoritative** — server is source of truth (required for billing/credit safety)
- **IndexedDB as cache only** — NOT local-first. See [data-architecture.md](../../foundations/data-architecture.md)
- **Optimistic send** — update state (render user message immediately) → POST + Dexie write concurrently → reconcile on response → start SSE stream
- **SSE resume** — persist event cursor alongside cached thread rows for safe reconnect during in-flight responses

## Carry Forward

- Existing `useThreadStore.ts` — thread/message state (network-first)
- Existing SSE streaming + catchup reconnection
- Existing `useThreadScrollController.ts` — scroll management

## v1 Fix

Current thread send waits for server response before rendering the user's message. Fix to optimistic: render immediately, POST in background.

## Dependencies

- CM6 shared extensions (chat input)
- @mentions (autocomplete in chat input) -- provided by F8 (@Mentions, Round 2b); Threads (F7) must work without this dependency
- Data layer (optimistic flow)
- Billing (credit check on send)
- Work items (thread belongs to a work item)
