---
detail: standard
audience: developer
---

# Database Schema

Complete PostgreSQL database schema for Meridian: file management + LLM thread system.

## System Overview

**Note:** Both `folders` and `documents` include a computed `path` field in API responses (not stored in database). This field contains the full hierarchical path including the entity's own name (e.g., "World Building/Locations/Cities"). See [API Contracts](../api/contracts.md#path-computation) for details.

```mermaid
erDiagram
    projects ||--o{ folders : "has many"
    projects ||--o{ documents : "has many"
    projects ||--o{ threads : "has many"
    folders ||--o{ folders : "has children"
    folders ||--o{ documents : "contains"
    threads ||--o{ turns : "has many"
    threads }o--|| turns : "last viewed"
    turns ||--o{ turns : "branches from"
    turns ||--o{ turn_blocks : "has many"

    projects {
        uuid id PK
        uuid user_id
        text name
        timestamptz created_at
        timestamptz updated_at
    }

    folders {
        uuid id PK
        uuid project_id FK
        uuid parent_id FK "nullable, self-ref"
        text name
        timestamptz created_at
        timestamptz updated_at
    }

    documents {
        uuid id PK
        uuid project_id FK
        uuid folder_id FK "nullable"
        text name
        text extension
        text content "markdown"
        jsonb metadata
        timestamptz created_at
        timestamptz updated_at
    }

    threads {
        uuid id PK
        uuid project_id FK
        uuid user_id
        uuid last_viewed_turn_id FK "nullable"
        text title
        timestamptz created_at
        timestamptz updated_at
    }

    turns {
        uuid id PK
        uuid thread_id FK
        uuid prev_turn_id FK "nullable, self-ref"
        text role "user|assistant"
        text status
        text error "nullable"
        text model "nullable"
        int input_tokens "nullable"
        int output_tokens "nullable"
        timestamptz created_at
        timestamptz completed_at "nullable"
    }

    turn_blocks {
        uuid id PK
        uuid turn_id FK
        text block_type
        int sequence
        text text_content "nullable"
        jsonb content "nullable, type-specific data"
        timestamptz created_at
    }
```

## File System

Hierarchical file organization with folders and markdown content.

### Tables

#### `projects`

Top-level container for all user content (documents + threads).

**Columns:**
- `id` (UUID, PK) - Auto-generated
- `user_id` (UUID) - Owner (not enforced as FK in Phase 1)
- `name` (TEXT) - Project name
- `created_at`, `updated_at` (TIMESTAMPTZ) - Timestamps
- `deleted_at` (TIMESTAMPTZ, nullable) - Soft delete timestamp

**Constraints:**
- `UNIQUE(user_id, name)` - No duplicate project names per user

**Deletion Behavior:**
- CASCADE to folders and threads
- RESTRICT on documents (must delete documents first)

#### `folders`

Hierarchical folder structure using adjacency list pattern (self-referencing tree).

**API Naming Note:** The database column is named `parent_id`, but the API exposes this field as `folder_id` for consistency with document references. Both folders and documents use `folder_id` in the API: folders reference their parent folder, documents reference their containing folder.

**Columns:**
- `id` (UUID, PK) - Auto-generated
- `project_id` (UUID, FK -> projects) - Parent project
- `parent_id` (UUID, FK -> folders, nullable) - Parent folder (NULL = root level)
- `name` (TEXT) - Folder name (no slashes allowed)
- `created_at`, `updated_at` (TIMESTAMPTZ) - Timestamps
- `deleted_at` (TIMESTAMPTZ, nullable) - Soft delete timestamp

**Constraints:**
- `UNIQUE(project_id, parent_id, name)` - No duplicate names at same level
- Self-referencing FK prevents orphaned folders (CASCADE on parent delete)

**Deletion Behavior:**
- CASCADE when parent folder or project deleted
- Backend validates against circular references (can't move folder into its own descendant)

**Indexes:**
- `idx_${TABLE_PREFIX}folders_project_parent` on `(project_id, parent_id)` - Fast hierarchy traversal
- `idx_${TABLE_PREFIX}folders_root_unique` on `(project_id, name) WHERE parent_id IS NULL` - Root uniqueness

#### `documents`

Content documents (leaf nodes in hierarchy). Store text-based content in `content` and format-specific stats in `metadata`.

**Columns:**
- `id` (UUID, PK) - Auto-generated
- `project_id` (UUID, FK -> projects) - Parent project
- `folder_id` (UUID, FK -> folders, nullable) - Parent folder (NULL = root level)
- `name` (TEXT) - Document name (no slashes allowed, filesystem semantics)
- `extension` (TEXT) - File extension with leading dot (e.g. `.md`, `.excalidraw`)
- `content` (TEXT) - Content for text-based formats (e.g. markdown, mermaid, excalidraw JSON)
- `metadata` (JSONB) - Format-specific stats (e.g. `metadata.markdown.wordCount`)
- `created_at`, `updated_at` (TIMESTAMPTZ) - Timestamps
- `deleted_at` (TIMESTAMPTZ, nullable) - Soft delete timestamp

**Constraints:**
- `UNIQUE(project_id, folder_id, name, extension)` - No duplicate filenames in same folder

**Deletion Behavior:**
- SET NULL when folder deleted (document moves to root, preserves content)
- RESTRICT when project deleted (must delete documents first)

**Indexes:**
- `idx_${TABLE_PREFIX}documents_project_id` on `project_id` - Fast project queries
- `idx_${TABLE_PREFIX}documents_project_folder` on `(project_id, folder_id)` - Fast folder queries
- `idx_${TABLE_PREFIX}documents_root_unique` on `(project_id, name, extension) WHERE folder_id IS NULL` - Root uniqueness

### Content Storage

**Format:** Text-based formats (TEXT)

Documents store text-based content in a single `content` TEXT column; file type is determined by `extension`.

**Why text-based first?**
- Single source of truth
- Search indexing
- Human-readable backups
- Import/export compatibility

### Path Computation

Paths are **computed** (not stored) by traversing folder hierarchy using recursive CTE.

**Why computed?**
- Single source of truth (folder names)
- Renaming folders updates all paths automatically
- No synchronization issues

**Implementation:** See `internal/service/docsystem/tree.go` and `internal/repository/postgres/docsystem/document.go:GetPath()`

### Folder Hierarchy

Uses **adjacency list pattern**: each folder has a `parent_id` pointing to its parent.

**Root folders:** `parent_id IS NULL`
**Nested folders:** `parent_id = <parent-folder-id>`

**Circular prevention:** Backend validates folder moves. See `internal/service/docsystem/folder.go:validateNoCircularReference()`

## Thread System

LLM-powered thread sessions with tree-structured conversations and unified JSONB content blocks.

```mermaid
graph TB
    thread[Thread Session]
    turn1[Turn 1<br/>user]
    turn2[Turn 2<br/>assistant<br/>model: claude-haiku-4-5]
    turn3a[Turn 3a<br/>user]
    turn3b[Turn 3b<br/>user<br/>branched conversation]
    cb1_text[Block 0<br/>type: text]
    cb1_ref[Block 1<br/>type: reference<br/>JSONB: ref_id, ref_type]
    cb2_think[Block 0<br/>type: thinking<br/>JSONB: signature]
    cb2_text[Block 1<br/>type: text]

    thread --> turn1
    turn1 --> turn2
    turn2 --> turn3a
    turn2 -.branch.-> turn3b
    turn1 --> cb1_text
    turn1 --> cb1_ref
    turn2 --> cb2_think
    turn2 --> cb2_text

    style thread fill:#2d5a7d
    style turn1 fill:#2d7d2d
    style turn2 fill:#7d2d5a
    style turn3a fill:#2d7d2d
    style turn3b fill:#2d7d2d
    style cb1_text fill:#7d5a2d
    style cb1_ref fill:#7d5a2d
    style cb2_think fill:#5a2d7d
    style cb2_text fill:#5a2d7d
```

### Tables

#### `threads`

Thread sessions scoped to projects.

**Columns:**
- `id` (UUID, PK) - Auto-generated
- `project_id` (UUID, FK -> projects) - Parent project
- `user_id` (UUID) - Owner
- `title` (TEXT) - Thread title
- `last_viewed_turn_id` (UUID, FK -> turns, nullable) - Last turn viewed by user (for UI navigation)
- `created_at`, `updated_at` (TIMESTAMPTZ) - Timestamps
- `deleted_at` (TIMESTAMPTZ, nullable) - Soft delete timestamp

**Deletion Behavior:**
- CASCADE when project deleted
- CASCADE to all turns (and transitively to turn_blocks)
- SET NULL on last_viewed_turn_id when referenced turn deleted

**Indexes:**
- `idx_${TABLE_PREFIX}threads_project` on `project_id` - Fast project queries
- `idx_${TABLE_PREFIX}threads_user` on `user_id` - Fast user queries
- `idx_${TABLE_PREFIX}threads_last_viewed` on `last_viewed_turn_id` - Fast navigation queries

#### `turns`

Conversation tree structure. Each turn is either a user message or assistant response.

**Columns:**
- `id` (UUID, PK) - Auto-generated
- `thread_id` (UUID, FK -> threads) - Parent thread session
- `prev_turn_id` (UUID, FK -> turns, nullable) - Previous turn in conversation (NULL = first turn)
- `role` (TEXT) - `'user'` or `'assistant'`
- `status` (TEXT) - One of: `'pending'`, `'streaming'`, `'waiting_subagents'`, `'complete'`, `'cancelled'`, `'error'`
- `error` (TEXT, nullable) - Error message if status = `'error'`
- `model` (TEXT, nullable) - LLM model identifier (e.g., `'moonshotai/kimi-k2-thinking'`) for assistant turns
- `input_tokens` (INT, nullable) - Token count for input context
- `output_tokens` (INT, nullable) - Token count for generated output
- `created_at` (TIMESTAMPTZ) - Turn creation time
- `completed_at` (TIMESTAMPTZ, nullable) - Turn completion time

**Note on System Prompts:**
System prompts are NOT stored per-turn. They are resolved at request time from:
1. `request_params.system` (user-provided)
2. `project.system_prompt` (project settings)
3. `thread.system_prompt` (thread settings)
4. Selected skills (loaded from DB via skill service)

See migration `00003_remove_turn_system_prompt.sql` for details.

**Constraints:**
- CHECK: `role IN ('user', 'assistant')`
- CHECK: `status IN ('pending', 'streaming', 'waiting_subagents', 'complete', 'cancelled', 'error')`
- Self-referencing FK enables tree structure (branching conversations)

**Deletion Behavior:**
- CASCADE when prev turn or thread deleted
- CASCADE to child turns (deletes entire conversation branch)
- CASCADE to turn_blocks

**Indexes:**
- `idx_${TABLE_PREFIX}turns_thread` on `thread_id` - Fast thread queries
- `idx_${TABLE_PREFIX}turns_prev` on `prev_turn_id` - Fast tree traversal

#### `turn_blocks`

Unified multimodal content for both user and assistant turns. Uses JSONB for type-specific structured data.

**Columns:**
- `id` (UUID, PK) - Auto-generated
- `turn_id` (UUID, FK -> turns) - Parent turn
- `block_type` (TEXT) - One of: `'text'`, `'thinking'`, `'tool_use'`, `'tool_result'`, `'image'`, `'reference'`, `'partial_reference'`
- `sequence` (INT) - Order within turn (0-indexed)
- `text_content` (TEXT, nullable) - Plain text content (for text, thinking, tool_result blocks)
- `content` (JSONB, nullable) - Type-specific structured data (see schemas below)
- `created_at` (TIMESTAMPTZ) - Block creation time

**Block Types:**
- **User blocks:** text, image, reference, partial_reference, tool_result
- **Assistant blocks:** text, thinking, tool_use
- **Both:** text (different purposes)

**JSONB Content Schemas:**

| Block Type | text_content | content (JSONB) | Example |
|------------|--------------|-----------------|---------|
| `text` | Plain text | `null` | User message or assistant response text |
| `thinking` | Reasoning text | `{"signature": "4k_a"}` (optional) | Claude's internal reasoning |
| `tool_use` | `null` | `{"tool_use_id": "toolu_...", "tool_name": "...", "input": {...}}` | LLM tool invocation |
| `tool_result` | Result text | `{"tool_use_id": "toolu_...", "is_error": false}` | Tool execution result |
| `image` | `null` | `{"url": "...", "mime_type": "...", "alt_text": "..."}` | Image attachment |
| `reference` | `null` | `{"ref_id": "...", "ref_type": "document|image|s3_document", "version_timestamp": "...", "selection_start": 0, "selection_end": 100}` | Document reference |
| `partial_reference` | `null` | `{"ref_id": "...", "ref_type": "document", "selection_start": 0, "selection_end": 100}` | Text selection reference |

**Constraints:**
- CHECK: `block_type IN ('text', 'thinking', 'tool_use', 'tool_result', 'image', 'reference', 'partial_reference')`
- UNIQUE: `(turn_id, sequence)` - Prevents duplicate sequences within a turn

**Deletion Behavior:**
- CASCADE when turn deleted

**Indexes:**
- `idx_${TABLE_PREFIX}turn_blocks_turn_sequence` on `(turn_id, sequence)` - Fast ordered retrieval
- `idx_${TABLE_PREFIX}turn_blocks_turn_type` on `(turn_id, block_type)` - Filter blocks by type
- `idx_${TABLE_PREFIX}turn_blocks_content_gin` (GIN) on `content` - Fast JSONB queries

**Validation:** Type-specific JSONB schemas validated in application layer. See `internal/domain/models/llm/content_types.go`

### Turn Tree Structure

Turns use a **linked-list tree** via `prev_turn_id` self-reference, enabling:

**Branching conversations:**
```
Turn 1 (user: "Write a story")
  └─ Turn 2 (assistant: "Once upon a time...")
      ├─ Turn 3a (user: "Make it darker")
      └─ Turn 3b (user: "Add more humor")  ← Branch from Turn 2
```

Each branch can continue independently. This allows users to explore alternative conversation paths.

**Root turns:** `prev_turn_id IS NULL` (first message in thread)
**Nested turns:** `prev_turn_id = <previous-turn-id>`

### Content Block Sequencing

Content blocks are **ordered within a turn** using the `sequence` field (0-indexed).

**Example user message with reference:**
```
Turn ID: abc-123
  └─ Block 0: type=text, text_content="Please review this:"
  └─ Block 1: type=reference, content={"ref_id": "xyz-456", "ref_type": "document"}
  └─ Block 2: type=text, text_content="What do you think?"
```

**Example assistant response with thinking:**
```
Turn ID: def-456
  └─ Block 0: type=thinking, text_content="User wants analysis...", content={"signature": "4k_a"}
  └─ Block 1: type=text, text_content="This document demonstrates..."
```

This preserves the exact order of multimodal content for LLM processing and display.

### Reference System

Content blocks can **reference documents** using the JSONB `content` field:

**Full document reference (`reference`):**
```json
{
  "ref_id": "uuid-of-document",
  "ref_type": "document",
  "version_timestamp": "2025-01-15T10:30:00Z"
}
```

**Text selection reference (`partial_reference`):**
```json
{
  "ref_id": "uuid-of-document",
  "ref_type": "document",
  "selection_start": 100,
  "selection_end": 500
}
```

**Use cases:**
- `'reference'` - Full document reference ("Review this entire document")
- `'partial_reference'` - Text selection ("Review lines 10-50")

This enables context-aware thread where LLM can access document content.

## Cross-System Features

### Dynamic Table Names

Tables use environment-specific prefixes to enable multiple environments in same database:

| Environment | Prefix | Example |
|-------------|--------|---------|
| dev | `dev_` | `dev_projects`, `dev_threads` |
| test | `test_` | `test_projects`, `test_threads` |
| prod | `prod_` | `prod_projects`, `prod_threads` |

**Configured via:** `ENVIRONMENT` environment variable
**Implementation:** See `internal/repository/postgres/connection.go`

**Code usage:**
```go
// ✅ Correct
query := fmt.Sprintf("SELECT * FROM %s WHERE id = $1", db.Tables.Documents)

// ❌ Wrong
query := "SELECT * FROM documents WHERE id = $1"
```

### Uniqueness Rules

**Projects:**
- `UNIQUE(user_id, name)` - No duplicate project names per user

**Folders:**
- `UNIQUE(project_id, parent_id, name)` - No duplicate names at same level
- Different levels can have same name (e.g., root `"Notes"` and `"Characters/Notes"`)

**Documents:**
- `UNIQUE(project_id, folder_id, name)` - No duplicate names in same folder
- Same name allowed in different folders

### Soft Delete System

Primary resources (projects, folders, documents, threads) support soft deletion via `deleted_at` timestamp.

**Behavior:**
- Soft-deleted resources return 404 (treated as non-existent)
- Create operations validate parents aren't soft-deleted (service layer validators)
- Soft-delete does NOT cascade to children
- Hard delete (row removal) uses database CASCADE rules

**Implementation:** See `internal/service/docsystem/validation.go` and `internal/service/llm/validation.go`

## Indexes

### File System

| Index | Columns | Type | Purpose |
|-------|---------|------|---------|
| `idx_${TABLE_PREFIX}projects_user_name` | `(user_id, name)` | UNIQUE | Enforce unique project names per user |
| `idx_${TABLE_PREFIX}folders_project_parent` | `(project_id, parent_id)` | BTREE | Fast hierarchy traversal |
| `idx_${TABLE_PREFIX}folders_root_unique` | `(project_id, name) WHERE parent_id IS NULL` | UNIQUE PARTIAL | Root-level folder uniqueness |
| `idx_${TABLE_PREFIX}documents_project_id` | `project_id` | BTREE | Fast project document queries |
| `idx_${TABLE_PREFIX}documents_project_folder` | `(project_id, folder_id)` | BTREE | Fast folder document queries |
| `idx_${TABLE_PREFIX}documents_root_unique` | `(project_id, name) WHERE folder_id IS NULL` | UNIQUE PARTIAL | Root-level document uniqueness |

### Thread System

| Index | Columns | Type | Purpose |
|-------|---------|------|---------|
| `idx_${TABLE_PREFIX}threads_project` | `project_id` | BTREE | Fast project thread queries |
| `idx_${TABLE_PREFIX}threads_user` | `user_id` | BTREE | Fast user thread queries |
| `idx_${TABLE_PREFIX}threads_last_viewed` | `last_viewed_turn_id` | BTREE | Fast navigation queries |
| `idx_${TABLE_PREFIX}turns_thread` | `thread_id` | BTREE | Fast thread turn queries |
| `idx_${TABLE_PREFIX}turns_prev` | `prev_turn_id` | BTREE | Fast tree traversal |
| `idx_${TABLE_PREFIX}turn_blocks_turn_sequence` | `(turn_id, sequence)` | BTREE | Fast ordered block retrieval |
| `idx_${TABLE_PREFIX}turn_blocks_turn_type` | `(turn_id, block_type)` | BTREE | Filter blocks by type |
| `idx_${TABLE_PREFIX}turn_blocks_content_gin` | `content` | GIN | Fast JSONB queries |

## Foreign Key Behavior Summary

### File System

| Parent | Child | FK Column | ON DELETE |
|--------|-------|-----------|-----------|
| projects | folders | project_id | CASCADE |
| projects | documents | project_id | RESTRICT |
| folders (parent) | folders (child) | parent_id | CASCADE |
| folders | documents | folder_id | SET NULL |

**Rationale:**
- CASCADE for folders: Structural cleanup (deleting parent folder deletes children)
- RESTRICT for documents: Prevent accidental data loss (must explicitly delete documents first)
- SET NULL for document folders: Preserve content (deleting folder moves documents to root)

### Thread System

| Parent | Child | FK Column | ON DELETE |
|--------|-------|-----------|-----------|
| projects | threads | project_id | CASCADE |
| threads | turns | thread_id | CASCADE |
| turns (prev) | turns (child) | prev_turn_id | CASCADE |
| turns | threads | last_viewed_turn_id | SET NULL |
| turns | turn_blocks | turn_id | CASCADE |

**Rationale:**
- All CASCADE: Thread data is transient/ephemeral (no accidental data loss concerns)
- Deleting a turn deletes entire conversation branch
- SET NULL for last_viewed_turn_id: Thread persists even if last viewed turn is deleted

## Setup

Schema managed via **migrations** (not static SQL file).

**Migration file:** `backend/migrations/00001_initial_schema.sql`
**Migration tool:** goose
**Environment:** Uses `ENVIRONMENT` variable for table prefixes

See `backend/CLAUDE.md` for development setup and `make seed-fresh` for test data seeding.

## References

- Connection setup: [connections.md](connections.md)
- Migration file: `backend/migrations/00001_initial_schema.sql`
- Table name configuration: `internal/repository/postgres/connection.go`
- Content validation: `internal/domain/models/llm/content_types.go`
