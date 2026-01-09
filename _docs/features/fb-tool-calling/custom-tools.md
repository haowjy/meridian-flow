---
stack: backend
status: complete
feature: "Custom Tools"
---

# Custom Tools

**Four custom tools for document access and editing: doc_view, doc_tree, doc_search, doc_edit.**

## Status: ✅ Complete

---

## doc_view

**Purpose**: Read document content or list folder contents

**Features**:
- Path resolution (Unix-style paths)
- Content truncation (20k chars max)
- Returns: `{type: "document|folder", content, documents, folders}`

**File**: `backend/internal/service/llm/tools/view.go`

---

## doc_tree

**Purpose**: Show hierarchical structure of folders/documents

**Features**:
- Metadata only (no content)
- Configurable depth limit

**File**: `backend/internal/service/llm/tools/tree.go`

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

## doc_edit

**Purpose**: Edit document content via AI suggestions (writes to `ai_version` column)

**Commands**:
- `str_replace`: Find and replace exact text
- `insert`: Insert text at specific line
- `append`: Add text at end
- `create`: Create new document

**Features**:
- Unix-style path resolution
- Edits go to `ai_version` (user review before accepting)
- Accumulative: multiple edits build on previous `ai_version`

**File**: `backend/internal/service/llm/tools/doc_edit.go`

---

## Known Gaps

❌ **doc_delete** - No tool to delete documents via AI

---

## Related

- See [builtin-tools.md](builtin-tools.md) for built-in tools
- See [continuation.md](continuation.md) for multi-turn usage
