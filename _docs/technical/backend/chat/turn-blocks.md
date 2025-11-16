---
detail: comprehensive
audience: developer
---

# Turn Block Schemas

Complete JSONB schema reference for all content block types.

## Schema Design

Content blocks use **two fields** for storage:

| Field | Type | Usage |
|-------|------|-------|
| `text_content` | TEXT | Plain text (text, thinking, tool_result blocks) |
| `content` | JSONB | Type-specific structured data |

**Why split storage?**
- Common text queries don't need JSONB parsing
- Type-specific data stays structured
- Cleaner than "everything in JSONB"

## Block Type Matrix

| Block Type | User | Assistant | text_content | content |
|------------|------|-----------|--------------|---------|
| text | ✅ | ✅ | Message text | null |
| thinking | ❌ | ✅ | Reasoning | Signature (opt) |
| tool_use | ❌ | ✅ | null | Tool invocation |
| tool_result | ✅ | ❌ | Result text | Tool metadata |
| image | ✅ | ❌ | null | Image data |
| reference | ✅ | ❌ | null | Doc reference |
| partial_reference | ✅ | ❌ | null | Selection reference |
| web_search_use | ❌ | ✅ | null | Server-side web search invocation |
| web_search_result | ❌ | ✅ | null | Server-side web search result payload |

## Block Types (DB View)

For full JSON schemas and streaming behavior, use the canonical LLM reference:  
`_docs/technical/llm/streaming/block-types-reference.md`.

From the backend/DB perspective:
- `text`: `text_content` holds plain text; `content` is always `null`.
- `thinking`: `text_content` holds reasoning text; `content.signature` (optional) stores extended-thinking signature.
- `tool_use`: `content` holds tool metadata (`tool_use_id`, `tool_name`, `input`); `text_content` is `null`.
- `tool_result`: `text_content` is optional human-readable output; `content.tool_use_id` + `content.is_error` describe status.
- `image`: `content` holds `{url, mime_type, alt_text?}`; `text_content` is `null`.
- `reference` / `partial_reference`: `content` holds document reference and optional selection offsets; `text_content` is `null`.
- `web_search_use`: server-side tool invocation (`tool_use_id`, `tool_name: "web_search"`, `input.query`, `execution_side: "server"`).
- `web_search_result`: normalized provider search result or error payload; `text_content` is `null`; `content.tool_use_id` links back to `web_search_use`.

Backend code that enforces these shapes:
- Domain model: `backend/internal/domain/models/llm/turn_block.go`
- Content validation: `backend/internal/domain/models/llm/content_types.go`

## Examples (DB-Focused)

### Document reference block

```json
{
  "turn_id": "uuid",
  "block_type": "reference",
  "sequence": 1,
  "text_content": null,
  "content": {
    "ref_id": "doc-uuid-1234",
    "ref_type": "document",
    "version_timestamp": "2025-01-15T10:30:00Z"
  }
}
```

DB concerns:
- Indexed via `idx_turn_blocks_content_gin` for queries like `content @> '{"ref_id": "doc-uuid-1234"}'`.
- Used by conversation-loading code to attach referenced documents.

### Web search result block

```json
{
  "turn_id": "uuid",
  "block_type": "web_search_result",
  "sequence": 2,
  "text_content": null,
  "content": {
    "tool_use_id": "srvtoolu_abc123",
    "results": [
      {
        "title": "Public Domain Poetry - Main Index",
        "url": "https://www.public-domain-poetry.com/",
        "page_age": ""
      }
    ]
  }
}
```

DB concerns:
- `block_type = 'web_search_result'` for filtering.
- `content->>'tool_use_id'` used to join back to the corresponding `web_search_use` block.

## Validation

JSONB schemas validated in Go application layer.

**Validation file:** `internal/domain/models/llm/content_types.go`

**Validation function:**
```go
func ValidateContent(blockType string, content map[string]interface{}) error
```

**Validation rules:**
- Required fields must be present
- Field types must match schema
- Enum values must be valid
- Numeric ranges validated where applicable

**Example validation errors:**
```
invalid content for tool_use block: missing required field 'tool_use_id'
invalid content for reference block: ref_type must be one of: document, image, s3_document
invalid content for partial_reference block: selection_start must be >= 0
```

## Helper Methods

**TurnBlock model methods:**

```go
// Check block ownership
func (cb *TurnBlock) IsUserBlock() bool
func (cb *TurnBlock) IsAssistantBlock() bool
func (cb *TurnBlock) IsToolBlock() bool
```

**Usage:**
```go
if block.IsUserBlock() {
    // Handle user-submitted content
}

if block.IsToolBlock() {
    // Handle tool use/result flow
}
```

## Database Constraints

**Table-level:**
```sql
CHECK (block_type IN ('text', 'thinking', 'tool_use', 'tool_result',
                      'image', 'reference', 'partial_reference',
                      'web_search_use', 'web_search_result'))
UNIQUE (turn_id, sequence)  -- Prevent duplicate sequences
```

**Indexes:**
```sql
CREATE INDEX idx_turn_blocks_turn_sequence ON turn_blocks(turn_id, sequence);
CREATE INDEX idx_turn_blocks_turn_type ON turn_blocks(turn_id, block_type);
CREATE INDEX idx_turn_blocks_content_gin ON turn_blocks USING GIN (content);
```

**GIN index enables fast JSONB queries:**
```sql
-- Find all blocks referencing a specific document
SELECT * FROM turn_blocks
WHERE content @> '{"ref_id": "doc-uuid"}';

-- Find all tool uses for a specific tool
SELECT * FROM turn_blocks
WHERE block_type = 'tool_use'
AND content->>'tool_name' = 'create_file';
```

## References

- [Chat Overview](overview.md) - Turn tree structure
- [Database Schema](../database/schema.md) - Table definition
- Validation: `internal/domain/models/llm/content_types.go`
- Domain model: `internal/domain/models/llm/turn_block.go`
