---
detail: comprehensive
audience: developer
---

# Stage 7: Local LLM (Ollama) via Bridge

Goal: Let the web UI stream model output from a local Ollama runtime, while keeping security and logging centralized in the bridge.

## Why Proxy Through Bridge

- Avoid direct browser access to an unauthenticated local API.
- One pairing/auth model for all local capabilities.
- Normalize streaming into Meridian's block model.

## API (Bridge)

- `GET /v1/llm/models`
  - output: list of local models (from Ollama tags)
- `POST /v1/llm/chat/stream`
  - input: `{ model, messages, params }`
  - output: SSE stream of:
    - token deltas
    - final message
    - usage (if available)

## Meridian Integration (Phased)

- Phase A (simplest):
  - Stream to UI
  - Persist final assistant text to backend as a normal assistant turn (text-only)
- Phase B:
  - Tool calling from local model (optional, later)

## Stage Exit Criteria

- User can select a local model and receive streamed responses in the web UI.
- Final output is persisted to backend thread history.

