# Lifecycle Hooks Design — GitHub Validation

**Date:** 2026-02-28
**Source:** Research of 10 real-world projects (Continue, Cline, Aider, LLM, LangGraph, Ollama, etc.)
**Purpose:** Validate design against existing implementations

---

## Real-World Patterns Found

### 1. Session Files (Like Our `pinned.json`)

| Tool | Implementation | Pattern |
|------|---|---|
| **Continue** | `core/util/history.ts` | Session JSON + index |
| **Simon Willison `llm`** | `llm/models.py` | SQLite conversation IDs |
| **LangGraph** | `checkpoint-sqlite/` | Durable checkpoint storage |
| **Cline** | Shadow git checkpoints | Version control alongside session |

**Validation:** Our `pinned.json` approach aligns with Continue/LLM. We could **optionally** extend to SQLite checkpoints later (LangGraph model) if needed.

---

### 2. Compaction Detection & Markers

| Tool | Method | Evidence |
|------|--------|----------|
| **Continue** | Auto-trigger + summary marker | `compaction.ts` (reduced history, marker message) |
| **Cline** | `PreCompact` hook | `hooks.mdx` (injectable hook point) |
| **Anthropic SDK** | Threshold + detection | `auto_compaction.py` example |
| **Aider** | Recursive summarization | `history.py` (token budget aware) |

**Validation:** Our "explicit signal + implicit detection" hierarchy matches Cline's `PreCompact` hook approach. Aider's summarization is optional enhancement.

---

### 3. Context Restoration Paths

| Tool | Strategy | Storage |
|------|----------|---------|
| **Continue** | Load session JSON | File system |
| **Simon Willison `llm`** | `--continue` flag or `--cid` | SQLite + conversation ID |
| **LangGraph** | `thread_id` checkpoints | SQLite or Postgres |
| **Cline** | Checkpoint tracker | Git-like version control |

**Validation:** Our "load at run start" + "optional manual refresh" matches LLM's `--continue` pattern. More sophisticated than needed initially.

---

### 4. Hook/Event Systems

| Tool | Approach | Usage |
|------|----------|-------|
| **Cline** | `PreCompact` hook | User can inject context before compaction |
| **Simon Willison `llm`** | Plugin hooks | `prompt_fragment`, `template` extension points |
| **Orchestrate** | `SessionStart`, `SessionEnd` | Skill reload, plan detection |

**Validation:** Our SessionStart/SessionEnd hooks match orchestrate. Cline's `PreCompact` is more sophisticated (prevent compaction), but our post-compaction detection is simpler.

---

### 5. System Prompt vs Reinjection

| Tool | Approach | Reasoning |
|------|----------|-----------|
| **Anthropic SDK** | `context_management` edits | Update instructions per-session |
| **OpenAI SDK** | `instructions` parameter | Per-request, not persistent |
| **Continue** | Template injection | Reinjected as context, not system prompt |
| **Aider** | Summarization + reinjection | Token budget aware |

**Validation:** Mixing system prompt (skills) + reinjection (files) is the standard pattern. No tool relies on pure system-prompt persistence.

---

## Key Validation Points

### ✅ JSON Storage (vs SQLite)
- **Continue** uses JSON for sessions (lightweight, human-readable)
- **LangGraph** uses SQLite for checkpoints (more complex, queryable)
- **Our choice:** JSON for Phase 1 (simple, works), SQLite for Phase 2+ (queryable, scalable)

### ✅ Explicit Pinning (vs Auto-Detection)
- **Continue** requires explicit session save/load
- **Cline** has auto-compaction but **user triggers** checkpoint save
- **Our choice:** Explicit `meridian context pin` (simple, predictable)

### ✅ Hybrid Injection (Skills + Files)
- **Aider** uses summarization (replace old context with summary)
- **Continue** uses reduced history + new context
- **Our choice:** Skills (system) + files (text) is middle ground, simpler

### ✅ Compaction Detection Hierarchy
- **Continue** has auto-trigger + summary marker
- **Cline** has `PreCompact` hook
- **Our choice:** Explicit signal + implicit detection + manual fallback

---

## Patterns We Should Adopt from GitHub Research

### 1. Conversation IDs / Session References
**From:** Simon Willison `llm`, LangGraph
**Adopt:** Add `conversation_id` or `session_ref` to pinned state for correlation with runs
```json
{
  "space_id": "w1-abc123",
  "session_ref": "session-2026-02-28-abc",
  "pinned_files": [...]
}
```

### 2. Optional Summarization on Compaction
**From:** Aider (token-aware), Continue (reduced history)
**Adopt (Phase 2):** When compaction detected, optionally offer to summarize conversation
```bash
meridian context summarize [--save-to-file]
```

### 3. Checkpoint Versioning (Git-like)
**From:** Cline (shadow git checkpoints)
**Adopt (Phase 3):** Track pin changes like git commits
```bash
meridian context history        # Show past pin sets
meridian context restore <ref>  # Restore to earlier pin set
```

### 4. Plugin Hooks for Custom Injection
**From:** Simon Willison `llm` (plugin system)
**Adopt (Future):** Allow users to register custom context types
```python
@meridian.hook("context.inject")
def inject_my_context():
    return "my custom context"
```

---

## Comparison: Our Design vs Existing Tools

| Aspect | Meridian (Proposed) | Continue | Cline | LLM | LangGraph |
|--------|---|---|---|---|---|
| **Session storage** | JSON | JSON | Git checkpoint | SQLite | SQLite/Postgres |
| **Session ID** | implicit | explicit | implicit | explicit | explicit `thread_id` |
| **Pinning** | Explicit CLI | Explicit save | Auto snapshot | Per-conversation | Per-thread |
| **Compaction detection** | Signal + implicit | Auto-trigger | `PreCompact` hook | Manual `--continue` | Implicit (thread) |
| **Restoration** | Auto at run start | Explicit load | Checkpoint restore | Manual flag | Auto per thread |
| **Skill/context persistence** | Skills (system prompt) + files (text) | Reduced history | Snapshot | Conversation history | Thread state |

**Summary:** Meridian's approach is **simplest** (good for MVP), **explicit** (user controls), and **leverages existing orchestrate hooks** (not reinventing).

---

## Design Recommendations (Based on GitHub Research)

### Phase 1 (Current Design) ✅
- `pinned.json` with explicit CLI commands
- SessionStart/SessionEnd hooks
- Compaction detection via signals
- Hybrid injection (skills + files)

### Phase 2 (Recommended Enhancements)
- Add `session_ref` / `conversation_id` for run correlation
- Implement `meridian context summarize` (Aider pattern)
- Add run history correlation in reports

### Phase 3 (Nice-to-Have)
- `meridian context history` / `restore` (Cline pattern)
- Plugin hooks for custom injection (LLM pattern)
- Optional SQLite backend for complex queries

---

## Key Takeaway

Our design is **validated** by real-world implementations:
- **Continue** validates JSON session + explicit save/load
- **Cline** validates `PreCompact` hooks + snapshots
- **LLM** validates explicit session IDs + conversation loading
- **LangGraph** validates checkpoint-aware threading
- **Aider** validates token-aware summarization

We're on the right track. Phase 1 is simple, proven, and implementable. Phases 2-3 can adopt sophisticated patterns from Continue, Cline, and LangGraph as meridian matures.
