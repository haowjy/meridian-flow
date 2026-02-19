---
detail: minimal
audience: developer
---

# OpenRouter OpenAI GPT tool-args stall (infinite whitespace)

## Summary

Some OpenAI GPT models via OpenRouter can stall during tool calling by streaming `tool_calls[].function.arguments` deltas that are whitespace-only (`" "`, `"\n\n"`, `"\r\r"`, `"\t\t...\n"`) indefinitely and never completing the tool call / finish_reason.

This manifests as an infinite `TOOL_CALL_ARGS` stream, unbounded argument accumulation, and/or a run that never completes.

## Observed

- Provider: OpenRouter
- Models: OpenAI GPT (notably `openai/gpt-5-mini` and versioned variants like `openai/gpt-5-mini-YYYY-MM-DD`)
- Symptom patterns:
  - Tool call starts once, then repeated `TOOL_CALL_ARGS` events with whitespace-only deltas.
  - Sometimes the accumulated tool args JSON is “almost complete” but missing a final `}`.

Example log excerpt (whitespace args deltas):
- `args:"\r\r"` -> `args:"\n\n\n"` -> `args:" "` -> `args:"\t\t\t\t\t\t\t\t\n"` (repeats)

## Current Mitigation

- Temporarily remove/disable GPT models from selection (commented out in capabilities YAML):
  - See `backend/internal/capabilities/config/openrouter.yaml`

## Why this becomes “infinite” in Meridian

Even if the upstream behavior is transient, the app can appear hung if:
- The stream is treated as “alive” when *any* bytes arrive (including whitespace-only tool-args deltas).
- Cancellation falls back to soft-cancel because capability lookup fails on provider-reported versioned model IDs.

## Next Steps (Fix Options)

Pick one or combine:

1) **Prefer Responses API for OpenAI models on OpenRouter**
   - If OpenRouter supports stable tool streaming via `/responses`, route OpenAI models to that path.

2) **Force-finalize on tool-args stall**
   - If tool args have not made *meaningful* progress for a timeout window:
     - stop reading provider stream,
     - emit a tool call end + tool_use block,
     - optionally attempt minimal JSON repair (e.g. append a missing final `}`),
     - otherwise emit malformed-tool recovery blocks.

3) **Normalize model IDs for capability/cancel**
   - Treat `openai/gpt-5-mini-YYYY-MM-DD` as `openai/gpt-5-mini` for capability lookup so hard-cancel works when supported.

