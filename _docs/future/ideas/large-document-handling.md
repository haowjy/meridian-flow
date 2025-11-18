# Large Document Handling

**Status**: Future Enhancement
**Priority**: Medium
**Context**: MVP0 Chat - Read-Only Tools (Backend-8)

---

## Problem

When tools like `get_document` fetch large documents (100k+ words), returning full content can:
- Exceed LLM provider token limits (context window)
- Increase latency and costs
- Provide unnecessary content (LLM may only need specific sections)

**Current MVP Approach**: Return full content, trust LLM to handle large context.

---

## Future Solutions

### Option 1: Provider-Level Document Upload

**Concept**: Upload large documents directly to provider using prompt caching.

**Benefits**:
- Provider handles chunking/indexing
- Leverages provider's prompt caching (cheaper, faster)
- LLM can reference document without re-sending content

**Providers Supporting This**:
- Anthropic: Prompt caching (docs in cache, reduced cost on repeated access)
- OpenAI: (Future) File uploads API

**Implementation**:
```go
// Upload document to provider's cache
cacheID := provider.UploadDocument(ctx, doc.Content)

// Reference in tool result
toolResult := map[string]interface{}{
    "document_id": doc.ID,
    "cache_ref": cacheID,  // Provider retrieves from cache
    "summary": doc.Content[:1000],  // Brief preview
}
```

### Option 2: Client-Side Document Chunking

**Concept**: Split documents into semantic chunks, retrieve only relevant sections.

**Implementation Steps**:
1. Chunk documents on write (save to `document_chunks` table)
2. Use embeddings for semantic search
3. `get_document` retrieves only relevant chunks based on query context

**Example**:
```sql
CREATE TABLE document_chunks (
    id UUID PRIMARY KEY,
    document_id UUID REFERENCES documents(id),
    chunk_index INT,
    content TEXT,
    embedding vector(1536),  -- Using pgvector
    created_at TIMESTAMPTZ
);

CREATE INDEX ON document_chunks USING ivfflat (embedding vector_cosine_ops);
```

**Tool Behavior**:
```go
// Instead of returning full document:
func (t *GetDocumentTool) Execute(ctx, input) {
    // Get user's query context
    queryContext := extractQueryContext(conversationHistory)

    // Retrieve relevant chunks only
    chunks := t.chunkRepo.SearchRelevantChunks(ctx, docID, queryContext, limit=5)

    return map[string]interface{}{
        "document_id": doc.ID,
        "chunks": chunks,
        "note": "Showing most relevant sections. Use search_documents to find other content."
    }
}
```

### Option 3: Pagination & Lazy Loading

**Concept**: Return document metadata + first N characters, allow tool to request more.

**Implementation**:
```go
// get_document returns summary
{
    "document_id": "...",
    "name": "Chapter 12",
    "preview": doc.Content[:10000],  // First 10k chars
    "total_length": len(doc.Content),
    "has_more": true
}

// New tool: get_document_section
{
    "tool_name": "get_document_section",
    "parameters": {
        "document_id": "...",
        "start_char": 10000,
        "length": 10000
    }
}
```

---

## Recommendation

**Short-term (MVP0)**: Return full content (current approach)

**Medium-term (Post-MVP)**: Implement provider-level upload with prompt caching (Option 1)
- Easiest to implement
- Leverages provider infrastructure
- Cost-effective

**Long-term (Scale)**: Hybrid approach
- Use prompt caching for frequently accessed documents
- Use embeddings + chunking for large corpus search
- Pagination for edge cases

---

## Related

- `backend-8-read-tools.md` - Current tool implementation
- `_docs/technical/backend/llm-integration.md` - LLM architecture
