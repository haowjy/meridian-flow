---
stack: backend
status: complete
feature: "Custom Read-Only Tools"
---

# Custom Read-Only Tools

**Three custom tools for document access: doc_view, doc_tree, doc_search.**

## Status: ✅ Complete (Read-Only)

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

## Known Gaps

❌ **Write tools** - No doc_create, doc_update, doc_delete

---

## Related

- See [builtin-tools.md](builtin-tools.md) for built-in tools
- See [continuation.md](continuation.md) for multi-turn usage
