# Tool Continuation Implementation Plan

**Status:** Ready to implement
**Priority:** High
**Estimated effort:** 4-6 hours

## Problem Statement

Tools execute successfully but the LLM never sees the results. Conversations stop mid-stream after tool execution instead of continuing with the tool results.

**Current behavior:**
```
User: "What files are in my project?"
Assistant: [thinking] → [tool_use: doc_tree]
Backend: Executes tool, persists tool_result
Backend: Sends turn_complete with stop_reason="tool_use"
❌ STOPS HERE (user never gets final answer)
```

**Expected behavior:**
```
User: "What files are in my project?"
Assistant: [thinking] → [tool_use: doc_tree]
Backend: Executes tool, persists tool_result
Backend: Continues streaming with tool results
Assistant: [text: "You have 3 files: a.txt, b.txt, c.txt"]
Backend: Sends turn_complete with stop_reason="end_turn"
✅ Complete conversation persisted
```

## Current State

### What Works ✅

**File:** `backend/internal/service/llm/streaming/mstream_adapter.go`

1. **Tool execution** (line 480):
   ```go
   toolResults := se.toolRegistry.ExecuteParallel(ctx, se.collectedTools)
   ```

2. **Tool result persistence** (lines 492-522):
   ```go
   for i, toolResult := range toolResults {
       resultBlock := &llmModels.TurnBlock{
           TurnID:      se.turnID,
           BlockIndex:  nextBlockIndex,
           BlockType:   "tool_result",
           ToolResultJSON: toolResult.ToJSON(),
       }
       se.turnRepo.CreateTurnBlock(ctx, resultBlock)
   }
   ```

3. **Tool result streaming** (lines 529-558):
   ```go
   se.sendEvent(send, llmModels.SSEEventBlockStart, ...)
   se.sendEvent(send, llmModels.SSEEventBlockDelta, ...)
   se.sendEvent(send, llmModels.SSEEventBlockStop, ...)
   ```

### What's Missing ❌

**File:** `backend/internal/service/llm/streaming/mstream_adapter.go:567-574`

```go
// TODO: Continue streaming with tool results
// This requires building a new GenerateRequest with the conversation history
// including the tool results, and calling the provider again
// For now, we'll complete the turn

se.logger.Warn("tool continuation not yet implemented, completing turn",
    "tool_count", len(toolResults),
)
```

**Impact:**
- Violates product goal: "users wouldn't lose conversation if they closed out"
- Tool-using conversations incomplete in database
- Users don't see final answers after tool execution

## Architecture Context

### Pattern A: Consumer-Side Tool Execution Loop

**Documented in:** `_docs/technical/backend/chat/llm-providers.md:419`

The backend implements **Pattern A**, where:
- Backend executes tools (not provider)
- Backend controls the continuation loop
- Frontend passively receives SSE events

**Loop structure:**
```go
for iteration < maxToolRounds {
    resp := provider.StreamResponse(ctx, req)

    if resp.StopReason != "tool_use" {
        break // Done!
    }

    // Execute tools
    toolResults := executeTools(resp.ToolCalls)

    // Add results to conversation
    req.Messages = append(req.Messages, Message{
        Role: "user",
        Blocks: toolResults,
    })
    // Loop continues...
}
```

**Current implementation:** Loop exists but continuation is stubbed out.

## Implementation Plan

### Phase 1: Refactor for Recursion (2-3 hours)

**Goal:** Make `workFunc` reusable for continuation streaming.

**File:** `backend/internal/service/llm/streaming/mstream_adapter.go`

**Changes:**

1. **Extract event processing** (new function at line ~600):
   ```go
   // processStreamingEvents processes events from streamChan and calls
   // executeToolsAndContinue if tool_use blocks are detected.
   func (se *StreamExecutor) processStreamingEvents(
       ctx context.Context,
       streamChan <-chan mstream.Event,
       send func(mstream.Event),
   ) error {
       // Move lines 116-168 from workFunc here
       // Handle deltas, persist blocks, detect tool_use
       // Call executeToolsAndContinue when needed
       return nil
   }
   ```

2. **Update workFunc** (line 99):
   ```go
   func (se *StreamExecutor) workFunc(ctx context.Context, send func(mstream.Event)) error {
       // Initial streaming setup (keep existing code)
       streamChan, err := se.startStreaming(ctx)
       if err != nil {
           return se.handleError(ctx, send, err)
       }

       // Use extracted processor
       return se.processStreamingEvents(ctx, streamChan, send)
   }
   ```

3. **Benefits:**
   - No code duplication
   - Continuation can reuse `processStreamingEvents`
   - Clear separation: setup vs. processing

### Phase 2: Implement Continuation (2-3 hours)

**Goal:** Replace TODO with working continuation logic.

**File:** `backend/internal/service/llm/streaming/mstream_adapter.go:567`

**Changes:**

1. **Load conversation history** (new code at line ~567):
   ```go
   func (se *StreamExecutor) executeToolsAndContinue(ctx context.Context, send func(mstream.Event)) error {
       // [Existing code: execute tools, persist results, stream results]
       // ...

       // NEW: Check iteration limit
       se.toolIteration++
       if se.toolIteration >= se.maxToolRounds {
           se.logger.Warn("max tool rounds reached, completing turn",
               "iterations", se.toolIteration,
           )
           return se.completeTurn(ctx, send, "max_tool_rounds")
       }

       // NEW: Load full conversation path
       path, err := se.turnNavigator.GetTurnPath(ctx, se.turnID)
       if err != nil {
           return fmt.Errorf("failed to load turn path: %w", err)
       }

       // NEW: Build messages including tool results
       messages, err := se.conversationSvc.BuildMessagesFromPath(ctx, path)
       if err != nil {
           return fmt.Errorf("failed to build messages: %w", err)
       }

       // NEW: Create continuation request
       contReq := &llmSvc.GenerateRequest{
           Messages: messages,
           Model:    se.req.Model,
           Params:   se.req.Params,
       }

       // NEW: Start new stream
       contStreamChan, err := se.provider.StreamResponse(ctx, contReq)
       if err != nil {
           return se.handleError(ctx, send, err)
       }

       // NEW: Reset state for next round
       se.collectedTools = nil
       se.currentBlockIndex++ // Continue block numbering

       // NEW: Process continuation stream (reuses phase 1 refactor)
       return se.processStreamingEvents(ctx, contStreamChan, send)
   }
   ```

2. **Add iteration tracking** (new field in StreamExecutor struct, line ~40):
   ```go
   type StreamExecutor struct {
       // ... existing fields
       toolIteration int // Track tool execution iterations
   }
   ```

3. **Add completeTurn helper** (new function at line ~650):
   ```go
   func (se *StreamExecutor) completeTurn(ctx context.Context, send func(mstream.Event), reason string) error {
       // Update turn status
       if err := se.turnRepo.UpdateTurnStatus(ctx, se.turnID, "complete", nil); err != nil {
           se.logger.Error("failed to update turn status", "error", err)
       }

       // Send completion event
       se.sendEvent(send, llmModels.SSEEventTurnComplete, llmModels.TurnCompleteEvent{
           TurnID:     se.turnID,
           StopReason: reason,
       })

       return nil
   }
   ```

### Phase 3: Testing (1-2 hours)

**Test cases:**

1. **Single tool execution:**
   ```
   User: "List my documents"
   → tool_use (doc_tree) → tool_result → text "You have X documents"
   Verify: Turn completes with stop_reason="end_turn"
   ```

2. **Multiple tool rounds:**
   ```
   User: "Search my docs and summarize"
   → tool_use (doc_search) → tool_result
   → tool_use (doc_view) → tool_result
   → text "Summary: ..."
   Verify: Multiple iterations work, final answer persisted
   ```

3. **Max iteration limit:**
   ```
   Setup: Tool that always triggers more tools
   Verify: Stops at maxToolRounds (5), logs warning
   ```

4. **Browser close during tool execution:**
   ```
   1. Start tool-using conversation
   2. Close browser while tool executes
   3. Reopen browser
   Verify: Catchup delivers full conversation including tool continuation
   ```

5. **Error handling:**
   ```
   Test: Tool execution failure
   Verify: Error persisted, turn marked failed, SSE sends error event
   ```

**Testing commands:**

```bash
# Run backend tests
cd backend
go test ./internal/service/llm/streaming/... -v

# Manual testing with curl
curl -X POST http://localhost:8080/api/chats/:chatId/turns \
  -H "Content-Type: application/json" \
  -d '{"role": "user", "blocks": [{"type": "text", "text": "List my documents"}]}'

# Watch SSE stream
curl -N http://localhost:8080/api/chats/:chatId/turns/:turnId/stream
```

## Dependencies

### Required Services

**TurnNavigator** (already exists):
```go
// backend/internal/service/turn_navigator.go
func (s *TurnNavigator) GetTurnPath(ctx context.Context, turnID uuid.UUID) ([]*models.Turn, error)
```

**ConversationService** (already exists):
```go
// backend/internal/service/llm/conversation/service.go
func (s *Service) BuildMessagesFromPath(ctx context.Context, path []*models.Turn) ([]llm.Message, error)
```

**Provider StreamResponse** (already exists):
```go
// meridian-llm-go/providers/provider.go
func (p Provider) StreamResponse(ctx context.Context, req *GenerateRequest) (<-chan Event, error)
```

### No Schema Changes Required

Existing schema supports:
- ✅ Multiple blocks per turn (tool_use + tool_result + text in same turn)
- ✅ Block ordering (block_index)
- ✅ Turn status tracking

## Rollout Strategy

### Step 1: Feature Flag (Optional)

Add environment variable for testing:
```go
// internal/config/config.go
type Config struct {
    EnableToolContinuation bool `env:"ENABLE_TOOL_CONTINUATION" envDefault:"true"`
}

// In mstream_adapter.go
if !se.config.EnableToolContinuation {
    se.logger.Warn("tool continuation disabled, completing turn")
    return se.completeTurn(ctx, send, "tool_use")
}
```

### Step 2: Deploy to Staging

1. Deploy backend with continuation enabled
2. Run integration tests
3. Monitor logs for warnings/errors
4. Test with real LLM providers (Anthropic, OpenRouter)

### Step 3: Deploy to Production

1. Enable for 10% of users (A/B test)
2. Monitor error rates, latency
3. Compare conversation completion rates
4. Roll out to 100%

## Monitoring

**Metrics to track:**

```go
// Add to metrics service
- tool_continuation_count (counter)
- tool_continuation_iterations (histogram)
- tool_continuation_errors (counter)
- tool_continuation_duration (histogram)
```

**Log events:**

```go
se.logger.Info("tool continuation started",
    "turn_id", se.turnID,
    "iteration", se.toolIteration,
    "tool_count", len(toolResults),
)
```

## Success Criteria

- [ ] Tool-using conversations complete automatically
- [ ] Tool results visible in database (turn_blocks)
- [ ] Final assistant response includes tool context
- [ ] Browser close doesn't lose conversation
- [ ] Max 5 tool iterations enforced
- [ ] SSE stream continues seamlessly across iterations
- [ ] Catchup works for tool continuation turns
- [ ] No regressions in non-tool conversations

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Infinite tool loops | ✅ maxToolRounds limit (5) already exists |
| Memory leaks from long streams | Monitor goroutine counts, add stream timeouts |
| Provider rate limiting | Add exponential backoff, respect rate limits |
| Complex refactor breaks existing flows | Comprehensive test coverage before changes |
| Frontend SSE reconnection issues | Test catchup mechanism with tool turns |

## Related Documentation

- `_docs/technical/llm/streaming/tool-execution.md` - Tool execution flow
- `_docs/technical/backend/chat/llm-providers.md` - Pattern A architecture
- `_docs/technical/llm/streaming/README.md` - Streaming overview
- `backend/CLAUDE.md:226-279` - Tool testing examples

## Next Steps After Implementation

1. **Optimize tool execution** (currently sequential, could parallelize)
   - See TODO at line 218-221 in mstream_adapter.go
   - Execute tools in background while streaming continues

2. **Add tool execution metrics** (latency, success rates)

3. **Improve error messages** (tool failures should be user-friendly)

4. **Consider tool caching** (avoid re-executing identical tool calls)

5. **Document tool continuation** in user-facing docs
