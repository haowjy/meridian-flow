**Status:** done

# Terminate Method Unit Tests

## Goal

Add focused unit coverage for `StreamExecutor.Terminate` so the unified cleanup path stays correct across all terminal reasons.

## Scope

- Add `backend/internal/service/llm/streaming/terminate_test.go`
- Cover all `TerminateReason` values
- Cover idempotency and pre-start termination
- Run `go test ./internal/service/llm/streaming/... -run TestTerminate -v -count=1`

## Notes

- Match the existing streaming test style and mocks
- Use recording test doubles for turn persistence, token finalization, billing settlement, and cleanup callback counts
