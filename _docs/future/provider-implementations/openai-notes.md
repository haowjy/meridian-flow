# OpenAI Provider Implementation Notes (openai-go, Responses API)

This doc captures implementation notes for adding a **direct OpenAI provider** (not via OpenRouter), using `github.com/openai/openai-go/v3` and the **Responses API**.

This repo’s provider architecture expects the provider implementation to live in **`meridian-llm-go`**, with the backend consuming normalized `StreamEvent{Delta, Block, Metadata}` events.

## Goals
- Stream text + tool calls into Meridian’s block model (`text`, `thinking` (optional), `tool_use`, `tool_result`).
- Persist authoritative token usage from the final response when possible.
- Define cancellation semantics (what is/isn’t hard-cancellable) and what metadata we can still obtain after cancel.

## Where This Fits in Meridian (Repo-Specific)
**Library (provider implementation):**
- Add `meridian-llm-go/providers/openai/` with `NewProvider(apiKey)` returning `llmprovider.Provider`.
- The library must emit deltas/blocks/metadata in Meridian’s normalized streaming format:
  - `meridian-llm-go/types.go` (`BlockDelta`, `Block`, `StreamMetadata`)

**Backend (wiring):**
- Enable `"openai"` in `backend/internal/service/llm/provider_factory.go` (currently commented as future provider).
- Ensure `"openai"` appears in model/provider listing if needed (`backend/internal/handler/models.go`).

## API Shape (Recommended)
Prefer **Responses** over Chat Completions for new work.

Key primitives:
- `response_id` (server-assigned) can be used for retrieval **only if** the response is stored.
- Streaming delivers a sequence of typed events; final event provides the full `Response` object (usage, output items, etc.).

## openai-go: Streaming (Responses)
The `openai-go` SDK exposes Responses streaming as an SSE stream of `ResponseStreamEventUnion` events.

Events to expect (non-exhaustive, names per SDK types):
- `ResponseTextDeltaEvent` / `ResponseTextDoneEvent` (incremental text)
- `ResponseFunctionCallArgumentsDeltaEvent` / `ResponseFunctionCallArgumentsDoneEvent` (incremental tool args)
- `ResponseOutputItemAddedEvent` / `ResponseOutputItemDoneEvent` (new output item boundaries)
- `ResponseCompletedEvent` (final response)
- `ResponseFailedEvent` (error)

Implementation notes:
- Treat streaming as an **event log**, not a “single text buffer”.
- Maintain per-`output_item_id` accumulators:
  - text accumulator (for message text parts)
  - JSON accumulator (for function/tool call arguments)
- Use “done” events to finalize blocks and persist them.

## Mapping Responses -> Meridian Blocks
### Critical Streaming Contract (Repo-Specific)
The backend does **not** assemble final blocks from provider-native fragments. The provider should:
- Emit `BlockDelta` for progressive UI updates (SSE).
- Emit a complete `Block` when the block is finished (this is what the backend persists to DB).

If you only emit deltas and never emit `Block`, the backend will not persist content correctly.

### Text
- `ResponseTextDeltaEvent`: emit `block_delta` (`text_delta`) and append to the current text accumulator.
- `ResponseTextDoneEvent`: finalize the current text block and persist it as a `text` block.

### Tool Calls (function calling)
OpenAI “tool calls” should map to Meridian’s `tool_use` + `tool_result` pattern.

- `ResponseOutputItemAddedEvent` tells you a new output item exists. Use its `item_id` as a stable correlation key.
- `ResponseFunctionCallArgumentsDeltaEvent`: append to args accumulator and (optionally) emit JSON deltas.
- `ResponseFunctionCallArgumentsDoneEvent`: parse full JSON; persist a `tool_use` block with Meridian’s expected shape:
  - `content.tool_use_id` (string)
  - `content.tool_name` (string)
  - `content.input` (object)

Then execute the tool server-side (Meridian tool registry) and persist `tool_result` blocks as usual.

#### Tool streaming details (to support existing UI)
Meridian’s backend can emit `tool_input_update` SSE events (progressive tool input) if the provider sends the right delta metadata.

To integrate cleanly with the existing streaming executor:
- On tool start, emit a `BlockDelta` with:
  - `DeltaType: tool_call_start`
  - `BlockType: "tool_use"` (set only on the first delta for this block)
  - `ToolCallID` + `ToolCallName` (or legacy `ToolUseID` + `ToolName`)
- For tool arguments, emit `DeltaType: json_delta` with `JSONDelta` chunks.

References:
- Backend delta model: `backend/internal/domain/models/llm/turn_block_delta.go`
- Backend tool-input streaming: `backend/internal/service/llm/streaming/mstream_adapter.go` (`processDelta` + `tool_input_update`)

### “Thinking” / Reasoning
OpenAI reasoning models may emit reasoning-related content.

Meridian guidance:
- Only map to a `thinking` block if we explicitly decide to display/store it.
- OpenAI does not provide Anthropic-style cryptographic signatures; if we store it, it should be treated as non-verifiable provider metadata.

## Token Usage + Response Metadata
### Completion
Persist usage from the final completed response (`ResponseCompletedEvent` / final response object) into:
- turn-level `input_tokens` / `output_tokens` (if provided by OpenAI)
- `turns.response_metadata.openai` (provider-specific):
  - `response_id`
  - `model` (actual)
  - any provider fields we care about (e.g., `system_fingerprint` if present, etc.)

### Multiple LLM Requests per Turn
If a single assistant turn triggers multiple OpenAI requests (tool continuation), use the same pattern as OpenRouter:
- Append per-request records under `response_metadata.openai.requests[]` (or similar).
- Continue to **accumulate** turn-level tokens across requests.

Repo quirk: the backend’s current persistence helpers overwrite `turns.response_metadata` when updating tokens/stop_reason unless the caller supplies the full merged map. If we want “append per request” metadata, we should introduce an atomic JSONB merge/append method at the repository layer (rather than read-modify-write races).

Reference:
- `backend/internal/repository/postgres/llm/turn.go` (`AccumulateTokensAndUpdateMetadata`, `UpdateTurnMetadata`)

## Cancellation Semantics (Important)
OpenAI does not have an OpenRouter-like “generation stats” lookup endpoint that returns canonical cost/tokens for a cancelled synchronous stream.

Practical options:
1. **Synchronous streaming (default)**:
   - Cancelling the HTTP request/stream may stop the stream, but you may not receive the final usage payload.
   - For token accuracy, treat as "not reliably hard-cancellable": prefer soft cancel (disconnect UI, keep provider request running) if we want to capture final usage; otherwise fall back to token counter or 0 tokens if the final response never arrives.
2. **Background mode (for strong cancel/retrieve semantics)**:
   - Create the response with `background: true` + `store: true`.
   - You can later `cancel` it server-side and `get` it by `response_id`.
   - This enables “cancel then fetch final usage later” workflows, but has product/privacy implications (storage; ZDR incompatibility).

Recommendation for Meridian:
- Ship with synchronous streaming first.
- Keep the existing “soft cancel” pattern for providers that don’t support post-hoc lookup (OpenAI, Gemini, Anthropic).
- Consider background responses only if we truly need resumability/cancel-by-id + retrieval.

## Suggested Debug Fields
Add these keys under `turns.response_metadata.openai`:
- `response_id`
- `token_source`: `"provider"` | `"token_counter"` | `"none"` (and optionally `"background_get"` if implemented)
- `token_metadata_final`: bool

## References
- openai-go v3 package docs: `https://pkg.go.dev/github.com/openai/openai-go/v3`
- Responses API: `https://platform.openai.com/docs/api-reference/responses`
- Background mode + cancellation: `https://platform.openai.com/docs/guides/background-mode`
