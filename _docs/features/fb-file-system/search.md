---
stack: both
status: partial
feature: "Full-Text Search"
---

# Full-Text Search

**PostgreSQL FTS with multi-language support and weighted ranking.**

## Backend: ✅ Complete

**Implementation**: `backend/internal/repository/postgres/docsystem/document.go:516-549`

**Features**:
- PostgreSQL `to_tsvector()` + `websearch_to_tsquery()`
- Multi-language (17 languages: English, Spanish, Chinese, etc.)
- Field filtering (name, content, or both)
- Field weighting (name: 2.0x, content: 1.0x)
- GIN indexes for performance
- Pagination (limit/offset)

**Endpoint**: `GET /api/documents/search?query=dragon&project_id=uuid&fields=name,content`

---

## Frontend: 🟡 Incomplete

**Search input**: Present in `DocumentTreePanel.tsx:58-78`
**Filtering logic**: Missing (doesn't actually filter tree)

---

## Missing Features

❌ **Vector search** - No embeddings, no semantic search
❌ **Hybrid search** - No combined FTS + vector ranking

---

## Related

- See `/_docs/technical/backend/search-architecture.md` for implementation details
