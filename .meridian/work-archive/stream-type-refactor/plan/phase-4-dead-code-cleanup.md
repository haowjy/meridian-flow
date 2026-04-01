# Phase 4: Dead Code Cleanup

## Scope

Remove all code that was made dead by the Stream type refactor. Verify nothing references removed code.

## Candidates for Removal

1. **`meridian-llm-go/stream_error_recovery.go`** — This is `MalformedToolRecovery`, NOT related to the Stream type refactor. **DO NOT DELETE.** It handles malformed tool JSON recovery and is still used by providers.

2. **Old channel patterns in usage_metering.go** — Should already be gone from Phase 1, but verify no proxy channel/goroutine code remains.

3. **Old streaming doc comments** — `streaming.go` should have updated comments marking `StreamEvent.Error` as internal transport only.

4. **Unused imports** — After all migrations, check for stale imports in modified files.

5. **Old test helpers** — If `test_helpers.go` had channel-based helpers that are now unused, clean them up.

## Verification Process

For each candidate:
1. `grep -r "SymbolName" meridian-llm-go/` to check references
2. `grep -r "SymbolName" backend/` to check backend references
3. Only delete if zero references remain
4. Run full test suite after each removal

## Verification Criteria

- [ ] `cd meridian-llm-go && go build ./...` compiles
- [ ] `cd meridian-llm-go && go test ./... -count=1` all pass
- [ ] `cd backend && go build ./...` compiles
- [ ] `cd backend && go test ./internal/service/llm/... -count=1` passes
- [ ] `grep -r "StreamErrorRecovery\|<-chan StreamEvent" meridian-llm-go/` returns zero hits in non-test, non-comment code (except internal transport in NewStreamFromChan)
- [ ] No unused imports remain in modified files
