# Phase 4.5: AI Collaboration Bridge

## Context

Phases 1-4 built the complete collab proposal infrastructure (Yjs sync, proposal lifecycle, review UI, arbiter strategies) but never connected the AI text generation system to it. When the AI edits a document via the `str_replace_based_edit_tool`, it saves to `documents.ai_version` (TEXT column) using the old PUA-marker diff system. No proposals are created, the review panel never shows, and the collab system sits dormant.

This phase bridges that gap: AI edits → Yjs updates → collab proposals → writer review/auto-accept.

**User decisions:**
- Auto-accept ON by default for all AI proposals
- Feature flag for old PUA system (new collab system ON by default)
- Full AI collab experience scope (bridge + UX polish)

## Architecture: Current → Target

```
CURRENT:
  TextEditorTool → documentSvc.UpdateAIVersion(text) → documents.ai_version → PUA markers

TARGET:
  TextEditorTool → mutationStrategy.Apply(base, new)
    ├─ CollabProposalStrategy → YjsConverter → ProposalService.CreateProposal
    │   → ProposalBroadcaster.Broadcast(mutations) → WS → editor
    └─ AIVersionStrategy (deprecated fallback) → UpdateAIVersion
```

**Key refactoring: Strategy pattern** — The tool doesn't branch on a flag. The builder injects the right strategy at construction time. This is cleaner than adding 3 fields + `if/else` to TextEditorTool.

---

## Slice 1: Yjs Text Diff Converter

**Goal:** Go utility that converts text diffs into Yjs update bytes **against the real Yjs state**.

**Critical design:** Updates must be ancestry-compatible with the live Y.Doc. Yjs relative updates require matching CRDT state vectors, not just matching visible text. The converter must work from the persisted `yjs_state` bytes, not from plain text.

### Algorithm

```
1. Load current yjs_state bytes from DocumentStore (or in-memory session)
2. Create base Y.Doc, apply yjs_state → establishes CRDT lineage
3. Read current text from base doc's Y.Text("content")
4. Diff current text vs newContent using sergi/go-diff (character-level)
5. Clone base state into target Y.Doc (same lineage)
6. Apply diff ops (delete/insert) on target's Y.Text
7. EncodeStateAsUpdate(target, EncodeStateVector(base)) → relative update bytes
```

This ensures the generated update has valid CRDT ancestry and can be applied to the live session doc.

### UTF-16 Position Handling

`y-crdt` uses UTF-16 code-unit indexing internally, while `sergi/go-diff` diffs by runes. For supplementary plane characters (emoji, CJK ext), rune positions ≠ UTF-16 positions. The converter must include a `runeOffsetToUTF16` helper that accounts for surrogate pairs (each supplementary char = 2 UTF-16 code units).

### Files

- **NEW** `backend/internal/service/collab/yjs_text_converter.go`
  - `YjsTextConverter` struct with `DocumentStore` dependency (to load `yjs_state`)
  - `TextToUpdate(ctx, documentID, newContent string) ([]byte, error)` — loads state, diffs, produces update
  - `runeOffsetToUTF16(text string, runeOffset int) int` — position conversion helper
  - Panic recovery wrapper (reuse `safeEncodeStateAsUpdate` pattern from `session_manager.go:413`)
  - Returns `nil, nil` for identical content (no-op — caller short-circuits)

- **NEW** `backend/internal/service/collab/yjs_text_converter_test.go`
  - Simple replacement, pure insertion, pure deletion, multi-line
  - **Emoji/supplementary char test** — verify UTF-16 positions don't drift
  - Round-trip: convert → apply update to base doc → verify content matches
  - Edge cases: empty base, empty new, identical content (nil update)

### Technical notes
- `sergi/go-diff` — Go port of diff-match-patch. `go get github.com/sergi/go-diff`
- Reference: `mustBuildDocState` in `ai_content_projector_test.go:238` for Yjs doc creation pattern
- Reference: `safeEncodeStateAsUpdate` in `session_manager.go:413` for panic recovery
- The converter loads state from the `DocumentStore` (same interface used by `session_manager.go`)

### Status: COMPLETE

### Verification
```bash
cd backend && go test ./internal/service/collab/ -run TestYjsTextConverter -v
```

---

## Slice 2: Thread Context Propagation + Provenance Contract

**Goal:** Pass thread/turn IDs through tool execution context for proposal provenance.

**Note:** `StreamExecutor` already has `threadID` (line 92) and `turnID` (line 31) fields, set during construction (`service.go:564`). We only need to inject these into the tool execution context.

### Provenance Contract

When `CollabProposalStrategy` creates a proposal, it populates:
- `ThreadID` = `se.threadID` (already available)
- `TurnID` = `se.turnID` (already available)
- `AgentRunID` = new UUID generated per-stream (one stream = one agent run)
- `ProducerAgentType` = `"editing_assistant"` (fixed constant for LLM tool edits)
- `CreatedByUserID` = user who initiated the thread turn

### Files

- **NEW** `backend/internal/service/llm/tools/thread_context.go`
  - Context key types (unexported, package-private)
  - `InjectThreadContext(ctx, threadID, turnID, userID string) context.Context`
  - `ExtractThreadContext(ctx) (threadID, turnID, userID string, ok bool)`

- **MODIFY** `backend/internal/service/llm/streaming/tool_executor.go`
  - In `executeToolsAndContinue`: inject thread context into `ctx` before `toolRegistry.ExecuteParallel`
  - Uses existing `se.threadID` and `se.turnID` fields (no struct changes needed)

### Status: COMPLETE

### Verification
```bash
cd backend && go test ./internal/service/llm/... -v
```

---

## Slice 3: DocumentMutationStrategy + Tool Integration + Broadcast

**Goal:** Refactor TextEditorTool to use a Strategy pattern for the save path. Wire collab proposal strategy with proper WS broadcasting.

### Key design: Strategy pattern (SRP + OCP + DIP)

```go
type DocumentMutationStrategy interface {
    Apply(ctx context.Context, input MutationInput) (*MutationResult, error)
}

type MutationInput struct {
    DocumentID  string
    UserID      string
    Path        string
    Base        string
    NewContent  string
    Description string
}

type MutationResult struct {
    Message    string
    Extra      map[string]interface{}
}
```

Two implementations:
- `AIVersionStrategy` — old path (deprecated fallback)
- `CollabProposalStrategy` — new path with YjsTextConverter + ProposalCreator + ProposalBroadcaster

### Critical: WS Broadcasting for Tool-Created Proposals

`ProposalBroadcaster` interface (ISP) extracted from handler-level broadcast logic.

### No-op Handling

When `base == newContent`, strategy short-circuits with "no changes needed" message.

### No Active Session Fallback

If no collab session exists, proposal still persists to DB. Log warning but don't fail.

### Files

- **NEW** `backend/internal/service/llm/tools/mutation_strategy.go`
- **NEW** `backend/internal/service/llm/tools/mutation_strategy_collab.go`
- **NEW** `backend/internal/handler/collab_proposal_broadcaster.go`
- **MODIFY** `backend/internal/service/llm/tools/text_editor.go`
- **MODIFY** `backend/internal/service/llm/tools/builder.go`
- **MODIFY** `backend/internal/config/config.go`
- **MODIFY** `backend/internal/service/llm/setup.go`
- **MODIFY** `backend/internal/service/llm/streaming/service.go`
- **MODIFY** `backend/cmd/server/main.go`

### Status: COMPLETE

### Verification
```bash
cd backend && go build ./... && go test ./internal/service/llm/tools/... -v
```

---

## Slice 4: Auto-Accept Default ON

**Goal:** System default auto-accept = true. AI proposals auto-apply unless arbiter downgrades.

### Files

- **MODIFY** `backend/internal/config/config.go` (line 77)
  - Change `MERIDIAN_COLLAB_DEFAULT_AUTO_ACCEPT` default from `"false"` to `"true"`
- **MODIFY** `backend/.env.example` — document setting

### Status: COMPLETE

### Verification
```bash
# Create AI edit → verify proposal auto-accepted (status='accepted', not 'proposed')
```

---

## Slice 5: Frontend Feature Flag + PUA Deprecation

**Goal:** Gate old PUA system off, new collab system on by default.

### Files

- **MODIFY** `frontend/src/features/documents/components/EditorPanel.tsx`
- **MODIFY** `frontend/.env.example`
- **MODIFY** `frontend/src/core/lib/mergedDocument.ts`

### Status: COMPLETE

### Verification
```bash
cd frontend && pnpm run lint
```

---

## Slice 6: Connection Status Indicator

**Goal:** Show WS state in editor UI.

### Files

- **NEW** `frontend/src/features/documents/components/CollabConnectionIndicator.tsx`
- **MODIFY** `EditorPanel.tsx`

### Status: COMPLETE

---

## Slice 7: Proposal Status in Thread UI

**Goal:** Badge on TextEditorBlock showing proposal accept/reject/pending state.

### Files

- **MODIFY** TextEditorBlock component
- **NEW** `frontend/src/features/documents/hooks/useProposalStatus.ts`

### Status: COMPLETE

---

## Slice 8: Version History Panel Toggle

**Goal:** Expose existing `VersionHistoryPanel` via toolbar button.

### Files

- **MODIFY** `EditorPanel.tsx`

### Status: COMPLETE

---

## Slice 9: Thread → Editor Navigation

**Goal:** "View in Editor" from thread navigates to document + selects proposal.

### Files

- **MODIFY** TextEditorBlock
- **MODIFY** `EditorPanel.tsx`

### Status: COMPLETE

---

## Slice 10: Cleanup + Documentation

### Files

- **NEW** `_docs/features/fb-collab-ai-bridge/README.md`
- **MODIFY** `_docs/features/README.md`
- Mark `UpdateAIVersion` as `@deprecated`
- Mark `ai_version` column as deprecated

### Status: COMPLETE

---

## Dependencies

```
Slice 1 (Yjs converter) ─┐
                          ├─ Slice 3 (Strategy + integration) ─── Slice 4 (Auto-accept)
Slice 2 (Thread context) ─┘                                   │
                                                               ├─ Slice 7 (Thread badges)
Slice 5 (Frontend flag) ──────────────────────────────────────┤
                                                               ├─ Slice 9 (Navigation)
Slice 6 (Connection indicator) ────── independent              │
Slice 8 (Version history) ─────────── independent              │
Slice 10 (Cleanup) ────────────────── after all others         │
```

## Pipeline

**Execute using `/orchestrate` skill.**

### Stage Configuration

| Stage | CLI | Model | Effort | Notes |
|-------|-----|-------|--------|-------|
| plan-slice | claude -p | opus | high | codex rate-limited from Phase 4 |
| implement | claude -p | opus | medium | |
| review | claude -p | opus | medium | single reviewer sufficient |
| commit | claude -p | haiku | low | |
