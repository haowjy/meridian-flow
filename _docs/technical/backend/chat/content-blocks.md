---
detail: comprehensive
audience: developer
---

# Content Block Schemas

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

## User Block Types

### `text`

Plain user message text.

**Fields:**
```sql
text_content: "Please analyze this character arc"
content:      null
```

**Example:**
```json
{
  "turn_id": "uuid",
  "block_type": "text",
  "sequence": 0,
  "text_content": "Please analyze this character arc",
  "content": null
}
```

### `image`

Image attachment (URL-based).

**Fields:**
```sql
text_content: null
content:      {"url": "...", "mime_type": "...", "alt_text": "..."}
```

**JSONB Schema:**
```typescript
{
  url: string          // Image URL (uploaded to S3/storage)
  mime_type: string    // "image/png", "image/jpeg", etc.
  alt_text?: string    // Optional accessibility text
}
```

**Example:**
```json
{
  "turn_id": "uuid",
  "block_type": "image",
  "sequence": 1,
  "text_content": null,
  "content": {
    "url": "https://storage.example.com/image.png",
    "mime_type": "image/png",
    "alt_text": "Character concept art"
  }
}
```

### `reference`

Full document reference (entire content).

**Fields:**
```sql
text_content: null
content:      {"ref_id": "...", "ref_type": "document", "version_timestamp": "..."}
```

**JSONB Schema:**
```typescript
{
  ref_id: string              // UUID of referenced document/image
  ref_type: string            // "document" | "image" | "s3_document"
  version_timestamp?: string  // ISO 8601 timestamp for versioning
  selection_start?: number    // Optional (for full doc, usually omitted)
  selection_end?: number      // Optional (for full doc, usually omitted)
}
```

**Example:**
```json
{
  "turn_id": "uuid",
  "block_type": "reference",
  "sequence": 0,
  "text_content": null,
  "content": {
    "ref_id": "doc-uuid-1234",
    "ref_type": "document",
    "version_timestamp": "2025-01-15T10:30:00Z"
  }
}
```

### `partial_reference`

Text selection within document (character range).

**Fields:**
```sql
text_content: null
content:      {"ref_id": "...", "ref_type": "document", "selection_start": 100, "selection_end": 500}
```

**JSONB Schema:**
```typescript
{
  ref_id: string            // UUID of referenced document
  ref_type: string          // "document" (image selections not supported)
  selection_start: number   // Character offset start (0-indexed)
  selection_end: number     // Character offset end (exclusive)
}
```

**Example:**
```json
{
  "turn_id": "uuid",
  "block_type": "partial_reference",
  "sequence": 1,
  "text_content": null,
  "content": {
    "ref_id": "doc-uuid-1234",
    "ref_type": "document",
    "selection_start": 150,
    "selection_end": 450
  }
}
```

**Note:** Selection offsets are character-based (not line-based). Frontend must convert between TipTap positions and character offsets.

### `tool_result`

Tool execution result sent back to LLM.

**Fields:**
```sql
text_content: "File created successfully"
content:      {"tool_use_id": "toolu_...", "is_error": false}
```

**JSONB Schema:**
```typescript
{
  tool_use_id: string  // Matches tool_use block that requested this
  is_error: boolean    // true if tool execution failed
}
```

**Example (success):**
```json
{
  "turn_id": "uuid",
  "block_type": "tool_result",
  "sequence": 2,
  "text_content": "File created at /path/to/file.txt",
  "content": {
    "tool_use_id": "toolu_abc123",
    "is_error": false
  }
}
```

**Example (error):**
```json
{
  "turn_id": "uuid",
  "block_type": "tool_result",
  "sequence": 2,
  "text_content": "Error: Permission denied",
  "content": {
    "tool_use_id": "toolu_abc123",
    "is_error": true
  }
}
```

## Assistant Block Types

### `text`

Assistant response text (same type as user text, different role).

**Fields:**
```sql
text_content: "The protagonist demonstrates growth through..."
content:      null
```

**Example:**
```json
{
  "turn_id": "uuid",
  "block_type": "text",
  "sequence": 1,
  "text_content": "The protagonist demonstrates growth through...",
  "content": null
}
```

### `thinking`

Internal reasoning (Claude's `<thinking>` blocks).

**Fields:**
```sql
text_content: "The user wants analysis of character development..."
content:      {"signature": "4k_a"}
```

**JSONB Schema:**
```typescript
{
  signature?: string  // Optional model signature (e.g., "4k_a", "12k_a")
}
```

**Example:**
```json
{
  "turn_id": "uuid",
  "block_type": "thinking",
  "sequence": 0,
  "text_content": "The user wants analysis of character development. I should focus on the protagonist's arc from Chapter 1 to Chapter 7.",
  "content": {
    "signature": "4k_a"
  }
}
```

**Note:** Signature indicates extended thinking mode (4k, 12k token windows).

### `tool_use`

LLM requesting tool execution.

**Fields:**
```sql
text_content: null
content:      {"tool_use_id": "toolu_...", "tool_name": "create_file", "input": {...}}
```

**JSONB Schema:**
```typescript
{
  tool_use_id: string             // Unique ID for this tool invocation
  tool_name: string               // Tool identifier ("create_file", "search_docs", etc.)
  input: Record<string, unknown>  // Tool-specific input parameters
}
```

**Example:**
```json
{
  "turn_id": "uuid",
  "block_type": "tool_use",
  "sequence": 1,
  "text_content": null,
  "content": {
    "tool_use_id": "toolu_abc123",
    "tool_name": "create_file",
    "input": {
      "path": "/docs/new_chapter.md",
      "content": "# Chapter 8\n\n..."
    }
  }
}
```

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

**ContentBlock model methods:**

```go
// Check block ownership
func (cb *ContentBlock) IsUserBlock() bool
func (cb *ContentBlock) IsAssistantBlock() bool
func (cb *ContentBlock) IsToolBlock() bool
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
                      'image', 'reference', 'partial_reference'))
UNIQUE (turn_id, sequence)  -- Prevent duplicate sequences
```

**Indexes:**
```sql
CREATE INDEX idx_content_blocks_turn_sequence ON content_blocks(turn_id, sequence);
CREATE INDEX idx_content_blocks_turn_type ON content_blocks(turn_id, block_type);
CREATE INDEX idx_content_blocks_content_gin ON content_blocks USING GIN (content);
```

**GIN index enables fast JSONB queries:**
```sql
-- Find all blocks referencing a specific document
SELECT * FROM content_blocks
WHERE content @> '{"ref_id": "doc-uuid"}';

-- Find all tool uses for a specific tool
SELECT * FROM content_blocks
WHERE block_type = 'tool_use'
AND content->>'tool_name' = 'create_file';
```

## References

- [Chat Overview](overview.md) - Turn tree structure
- [Database Schema](../database/schema.md#content-blocks) - Table definition
- Validation: `internal/domain/models/llm/content_types.go`
- Domain model: `internal/domain/models/llm/content_block.go`
