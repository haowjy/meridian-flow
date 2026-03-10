# Audit: LLM/AI Subsystem (gpt-5.4, p26)

## HIGH

- **Proposal accept not transactional** `proposal_service.go:153,218,363`, `session_manager.go:143` — `ApplyUpdate(...)` runs before the surrounding DB transaction commits. If a later DB step fails, content advances while proposal state rolls back.

- **Stream-prep leaks executors** `streaming/service.go:605,645,659,674,691` — After cleanup ownership transfers, early returns never invoke cleanup. Leaks executors and per-user stream slots.

- **SSE concurrent writes** `sse_handler.go:226`, `sse/keepalive.go:53`, `sse/writer.go:34` — Main loop and keepalive goroutine both write SSE events without synchronization. Can interleave frames or trigger false disconnects.

- **ai_content clobbered on live persist** `session_manager.go:191,398`, `text_editor.go:136,295,388` — Live collab persistence overwrites projected `ai_content` with base `content`. LLM editing reads `ai_content`, so pending AI proposals can silently disappear from the AI-visible view.

- **Context-limit warning invalid text block** `message_builder.go:165`, `adapters/conversion.go:67` — Warning text written into `Content["text"]` instead of `TextContent`, but adapter conversion only forwards `TextContent`. Warning is dropped or makes payload malformed on long threads.

## MEDIUM

- **Cancel strategy from model string** `streaming/service.go:1098,1139` — Cancel strategy chosen from model string instead of persisted provider. Claude-via-OpenRouter can take wrong hard/soft cancel path.

- **Parallel tool rounds race** `tools/registry.go:185`, `text_editor.go:295,388` — Tool rounds run in parallel but `str_replace`/`insert` assume sequentially updated `ai_content`. Same-turn edits to one document can race and produce conflicting proposals.

- **Token accounting incomplete** `tokens/finalizer.go:63,114,143`, `tokens/anthropic.go:18` — Anthropic token parser exists but is not wired in. Cancelled Claude runs can persist zero tokens.

- **Adapter goroutine leaks** `anthropic_adapter.go:69`, `openrouter_adapter.go:69`, `lorem_adapter.go:77` — `StreamResponse` wrappers send into unbuffered channel with no cancellation select. Goroutines can leak.

- **Idempotent replay as error** `collab_proposal.go:175` — `proposal:accept` replay surfaced as error. Retry after dropped ack looks like failure even though accept committed.

- **Disabled skills exposed** `skill/project_skill.go:42,187`, `tools/skill_invoke.go:112` — Listing/invocation ignore `Enabled` flag. Disabled skills are still exposed to LLM.

- **Create-file leaves empty doc on proposal failure** `text_editor.go:481,495` — `str_replace_based_edit_tool create` persists empty document before proposal creation. If proposal creation fails, empty file left behind.

## LOW

- **Debug path diverges from production** `streaming/debug.go:100`, `text_editor.go:63` — Debug provider-request path can panic on document tools.

- **Reconnect catchup misses terminal events** `streaming/catchup.go:53`, `sse_handler.go:153` — Only replays `RUN_STARTED`. Completed streams cleared/closed, so reconnect race can miss `RUN_FINISHED`/`RUN_ERROR`.

- **Web-search config inconsistent** `streaming/service.go:506`, `config.go:37` — Runtime always hardcodes Tavily despite exposing `SEARCH_API_PROVIDER` config.
