---
detail: minimal
audience: developer
status: legacy
---

# Backend-Library Streaming Integration (Legacy)

This document previously described an earlier streaming stack based on a custom
`TurnExecutor` + in-process accumulator. That design has been replaced by:

- `meridian-stream-go` for stream management and catchup
- `StreamExecutor` in `backend/internal/service/llm/streaming/mstream_adapter.go`
- Provider-agnostic streaming in `meridian-llm-go` (`StreamEvent`, `BlockDelta`)

For the **current behavior**, use:

- Streaming architecture (backend focus):  
  `architecture/streaming-architecture.md`
- LLM streaming overview + block semantics (library focus):  
  `../llm/streaming/README.md`
- Canonical block types and schemas:  
  `../llm/streaming/block-types-reference.md`

This file is kept only as a historical note and should not be used as a source
of truth for implementation details.

