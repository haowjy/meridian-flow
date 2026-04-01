# Phase 5: Executor Integration + Enrichment Settlement + Reconciliation

## Scope

Inject billing collaborators into the StreamExecutor, add gate checks at 3 admission points, add settlement at all terminal paths, create the CREDITS_EXHAUSTED SSE event, extend EnrichGenerationJob for deferred settlement, and add the reconciliation job.

This is the highest-risk phase — it touches the core streaming pipeline.

## Dependencies

- Phase 1: domain types, settlement modes
- Phase 3: CreditAdmissionChecker, CreditSettler interfaces + implementations

## Files to Modify

### StreamExecutor — Core Integration

- `backend/internal/service/llm/streaming/mstream_adapter.go` (MODIFY)

  Add fields to `StreamExecutor`:
  ```go
  creditAdmissionChecker billing.CreditAdmissionChecker
  creditSettler          billing.CreditSettler
  settlementMode         billing.CreditSettlementMode
  ```

  Update constructor `NewStreamExecutor` to accept these 3 new parameters.

  In `workFunc()`:
  - After emitting `RUN_STARTED`, BEFORE `updateTurnStatus("streaming")`:
    - Call `se.creditAdmissionChecker.CheckAdmission(ctx, se.userID)`
    - On denial: call `se.handleCreditsExhausted(ctx, send, 0, "initial")` and return nil (not error)
    - On admit: continue to `updateTurnStatus` and `emitStepStarted`

- `backend/internal/service/llm/streaming/tool_executor.go` (MODIFY)

  In `executeToolsAndContinue()`:
  - After `requestIndex++` and BEFORE `emitStepStarted()`:
    - Call `se.creditAdmissionChecker.CheckAdmission(ctx, se.userID)`
    - On denial: call `se.handleCreditsExhausted(ctx, send, se.requestIndex, "tool_continue")` and return nil

  In `executeToolsAndContinueWithLimit()`:
  - After `requestIndex++` and BEFORE the provider call:
    - Call `se.creditAdmissionChecker.CheckAdmission(ctx, se.userID)`
    - On denial: call `se.handleCreditsExhausted(ctx, send, se.requestIndex, "graceful_completion")` and return nil

### Settlement in Terminal Paths

- `backend/internal/service/llm/streaming/completion_handler.go` (MODIFY)

  In `handleCompletion()`:
  - After token finalization and metadata persistence, BEFORE tool execution decision:
    - If `se.settlementMode == CreditSettlementInlineAuthoritative`:
      - Call `se.settleCurrentRequest(ctx, metadata)` (new helper)
    - If `se.settlementMode == CreditSettlementDeferredToEnrichment`:
      - Persist billing ids and `billing_status = pending` on generation record
      - (EnrichGenerationJob handles actual settlement)

  In `handleError()`:
  - After token finalization (if tokens available):
    - If inline authoritative and tokens finalized: call `se.settleCurrentRequest(ctx, metadata)`
    - If deferred: persist pending billing status

- `backend/internal/service/llm/streaming/cancel_handler.go` (MODIFY)

  In `handleTimeoutInStreamingGoroutine()`:
  - After token finalization:
    - Same settlement logic as handleError (if tokens available, settle; otherwise defer)

### New Helper Methods

- `backend/internal/service/llm/streaming/billing_handler.go` (NEW)

  `handleCreditsExhausted(ctx, send, requestIndex int, phase string)`:
  - Persist existing blocks (do not delete partial content)
  - Mark turn `status = credit_limited`, `error = "insufficient credits"`
  - Emit `CREDITS_EXHAUSTED` SSE event via AG-UI emitter
  - Emit `RUN_FINISHED` with `stopReason = "credits_exhausted"`

  `settleCurrentRequest(ctx, metadata *StreamMetadata)`:
  - Build `SettleRequestInput` from executor state (userID, turnID, requestIndex, model, token counts from metadata)
  - Call `se.creditSettler.SettleAuthoritativeRequest(ctx, req)`
  - Log warning on failure but do NOT fail the turn (billing is best-effort after successful inference)

### CREDITS_EXHAUSTED SSE Event

- `backend/internal/service/llm/streaming/agui/events.go` (MODIFY — or new file)
  - Add `MeridianEventTypeCreditsExhausted = "CREDITS_EXHAUSTED"`
  - Add `MeridianCreditsExhaustedEvent` struct
  - Add emitter method for credits exhausted

### Service Wiring

- `backend/internal/service/llm/streaming/service.go` (MODIFY)
  - Add `creditAdmissionChecker` and `creditSettler` and `settlementMode` to streaming service fields
  - Pass them through to `NewStreamExecutor` at construction time

- `backend/internal/service/llm/setup.go` (MODIFY)
  - Accept billing collaborators in `SetupServices`
  - Pass through to streaming service

- `backend/cmd/server/main.go` (MODIFY)
  - Pass `admissionChecker`, `creditSettler`, and settlement mode to `SetupServices`
  - Settlement mode derived from provider config (Anthropic → inline, OpenRouter → deferred)

### EnrichGenerationJob — Deferred Settlement

- `backend/internal/jobs/enrich_generation.go` (MODIFY)
  - Add `creditSettler billing.CreditSettler` field
  - After successful enrichment (native tokens available):
    - Build `SettleRequestInput` with native token counts (prompt, completion, reasoning, cached)
    - Call `creditSettler.SettleAuthoritativeRequest(ctx, req)`
    - Log settlement result

### Reconciliation Job

- `backend/internal/jobs/reconcile_billing.go` (NEW)
  - `ReconcileBillingJob` struct
  - Scans for generation records with `billing_status = pending` older than 5 minutes
  - For each: call `creditSettler.RetryPendingSettlement(ctx, req)`
  - Max 5 retries over 24 hours — after that, mark `billing_status = failed` and log alert
  - Runs as periodic job in the job queue (every 15 minutes)

### Expiration Job

- `backend/internal/jobs/expire_credits.go` (NEW)
  - `ExpireCreditsJob` struct
  - Calls `creditStore.ExpireAvailableLots(ctx, now, batchSize)`
  - Runs as periodic job (every hour)
  - Logs expired lot count

### Noop Wiring Update

- `backend/internal/service/billing/noop.go` (MODIFY if needed)
  - Ensure noop implementations work for dev/test where Stripe is not configured

## Patterns to Follow

- Executor methods: `backend/internal/service/llm/streaming/mstream_adapter.go` (workFunc)
- AG-UI events: `backend/internal/service/llm/streaming/agui/` directory
- Job pattern: `backend/internal/jobs/enrich_generation.go`

## Constraints

- Settlement failures MUST NOT fail the turn — the user already received the model output
- Gate denial on initial request: do NOT emit STEP_STARTED, do NOT mark turn "streaming"
- Gate denial on continuation: preserve all previously persisted blocks
- handleCreditsExhausted is a dedicated path — do NOT route through handleError (that emits RUN_ERROR)
- Settlement mode is per-provider, not per-request. Derive from provider name.
- EnrichGenerationJob already has `attempt` and `lastError` fields for retry tracking — extend, don't duplicate

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./internal/service/llm/streaming/...` passes
- [ ] `cd backend && go test ./internal/jobs/...` passes
- [ ] Server starts with noop billing (dev mode)
- [ ] Admission denial on initial request produces CREDITS_EXHAUSTED SSE event (not HTTP 402)
- [ ] Admission denial on continuation preserves existing blocks
- [ ] Settlement failure is logged but does not fail the turn
- [ ] Reconciliation job processes pending settlements
