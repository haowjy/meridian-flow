---
status: future
priority: high
featureset: search
---

# Vector Search (Semantic Search)

**Status:** Not yet implemented
**Strategy:** `SearchStrategyVector`

## Overview

Enable semantic search using vector embeddings to find conceptually similar documents, not just keyword matches.

**Benefits:**
- Finds semantically similar content (synonyms, paraphrases)
- Language-independent (works across languages)
- Handles conceptual queries ("sad ending" finds "tragic conclusion")

**Trade-offs:**
- Requires embedding generation (API cost + latency)
- Higher storage cost (1536 floats per document)
- Slower than FTS for exact keyword matching

## Prerequisites

### 1. Enable pgvector Extension

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2. Add Embedding Column

```sql
ALTER TABLE documents ADD COLUMN embedding vector(1536);
```

### 3. Create Vector Index

```sql
-- IVFFlat (faster indexing, good for large datasets)
CREATE INDEX idx_documents_embedding
ON documents USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- HNSW (better accuracy, slower indexing)
CREATE INDEX idx_documents_embedding_hnsw
ON documents USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

## Implementation Plan

### 1. Add Embedding Generation Service

```go
// internal/service/embeddings/generator.go
type EmbeddingGenerator interface {
    Generate(ctx context.Context, text string) ([]float64, error)
}

// OpenAI implementation
type OpenAIEmbeddings struct {
    client *openai.Client
}

func (e *OpenAIEmbeddings) Generate(ctx context.Context, text string) ([]float64, error) {
    resp, err := e.client.CreateEmbeddings(ctx, openai.EmbeddingRequest{
        Model: "text-embedding-ada-002",  // 1536 dimensions
        Input: text,
    })
    return resp.Data[0].Embedding, err
}
```

### 2. Generate Embeddings on Document Create/Update

```go
func (s *DocumentService) CreateDocument(ctx context.Context, doc *Document) error {
    // Generate embedding
    embedding, err := s.embeddingGen.Generate(ctx, doc.Content)
    if err != nil {
        // Log warning, but don't fail document creation
        s.logger.Warn("failed to generate embedding", "error", err)
    } else {
        doc.Embedding = embedding
    }

    return s.repo.Create(ctx, doc)
}
```

### 3. Implement Vector Search

```go
func (r *PostgresDocumentRepository) vectorSearch(ctx context.Context, opts *SearchOptions) (*SearchResults, error) {
    // Generate query embedding
    queryEmbedding, err := r.embeddingGen.Generate(ctx, opts.Query)
    if err != nil {
        return nil, fmt.Errorf("generate query embedding: %w", err)
    }

    // Vector similarity search
    query := fmt.Sprintf(`
        SELECT id, project_id, folder_id, name, content, word_count, created_at, updated_at,
               1 - (embedding <=> $1) AS similarity_score
        FROM %s
        WHERE project_id = $2
          AND deleted_at IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1
        LIMIT $3 OFFSET $4
    `, r.tables.Documents)

    // embedding <=> $1 is cosine distance (lower = more similar)
    // 1 - distance = similarity score (higher = more similar)

    rows, err := executor.Query(ctx, query, queryEmbedding, opts.ProjectID, opts.Limit, opts.Offset)
    // ... scan results
}
```

## Usage Example

```go
opts := &SearchOptions{
    Query:     "epic battle scene with magical elements",
    ProjectID: projectID,
    Strategy:  SearchStrategyVector,  // Use semantic search
}
results, err := repo.SearchDocuments(ctx, opts)
```

## Performance Optimization

### Index Tuning (IVFFlat)

```sql
-- lists = sqrt(total_documents)
-- For 10,000 docs: lists = 100
-- For 100,000 docs: lists = 316
CREATE INDEX idx_documents_embedding
ON documents USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 316);
```

### Index Tuning (HNSW)

```sql
-- m = 16 (default, good for most cases)
-- ef_construction = 64-128 (higher = better accuracy, slower build)
CREATE INDEX idx_documents_embedding_hnsw
ON documents USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 128);
```

### Query-Time Parameters

```sql
-- Increase search quality (at cost of speed)
SET ivfflat.probes = 10;  -- Default: 1
SET hnsw.ef_search = 40;  -- Default: 40
```

## References

- pgvector Documentation: https://github.com/pgvector/pgvector
- OpenAI Embeddings API: https://platform.openai.com/docs/guides/embeddings
- Current search implementation: `_docs/technical/backend/search-architecture.md`
