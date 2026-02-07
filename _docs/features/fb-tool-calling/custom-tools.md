---
stack: backend
status: complete
feature: "Custom Tools"
---

# Custom Tools

**Two custom tools for document access and editing: str_replace_based_edit_tool, doc_search.**

## Status: ✅ Complete

---

## str_replace_based_edit_tool

**Purpose**: View or edit documents (unified tool matching Anthropic's text_editor_20250728)

**Reference**: [Anthropic Text Editor Tool Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)

**Commands**:
- `view`: Read document content (with line numbers) or list folder contents
- `str_replace`: Find and replace exact text
- `create`: Create new document
- `insert`: Insert text at specific line

**Features**:
- Unix-style path resolution
- Line-numbered output for view (`1: line1\n2: line2...`)
- View pagination via `view_range: [start, end]`
- Edits go to `ai_version` (user review before accepting)
- Accumulative: multiple edits build on previous `ai_version`
- Legacy `doc_view`/`doc_edit` tool names fully migrated (migration 00016)

**File**: `backend/internal/service/llm/tools/text_editor.go`

---

## doc_search

**Purpose**: Full-text search across documents

**Parameters**: query, folder filter, limit, offset

**Returns**: Results with preview snippets, scores, total count

**File**: `backend/internal/service/llm/tools/search.go`

---

## Tool Registry

**Parallel Execution**: `ExecuteParallel()` for concurrent tool calls

**Error Handling**: Per-tool error tracking

**File**: `backend/internal/service/llm/tools/registry.go`

---

## Known Gaps

❌ **doc_delete** - No tool to delete documents via AI

---

## Related

- See [builtin-tools.md](builtin-tools.md) for built-in tools
- See [continuation.md](continuation.md) for multi-turn usage
