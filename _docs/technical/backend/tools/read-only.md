# Read-Only Tools: Design Rationale

**Version:** 1.0  
**Date:** November 2025
**Status:** Approved Design

---

## Context & Problem Statement

Meridian is a cloud-based writing application where users organize their creative work into projects containing documents and folders. We're adding AI chat capabilities where the LLM assistant needs to access and understand the user's document structure and content.

**The Challenge:**  
How should the LLM view and navigate the user's documents? We need to balance:
- Natural interaction (paths users understand)
- Efficient navigation (minimal round-trips)
- Semantic clarity (each tool has a clear purpose)
- Implementation simplicity (avoid over-engineering)

---

## Design Philosophy

### Path-Centric, Not UUID-Centric

**Decision:** Tools use paths as primary identifiers, not UUIDs.

**Why:**
- **Matches user mental model** - Users think "Characters/Elara", not "uuid-abc-123"
- **Matches API design** - Our API already supports Unix-style path notation for document creation
- **Natural for LLMs** - Trained on filesystem conventions (`/path/to/file`)
- **Reduces friction** - No UUID lookup dance before accessing content

**Storage vs Interface:**  
While documents/folders are stored with UUID foreign keys internally, paths are the computed user-facing abstraction. Tools operate at the interface level (paths), not the storage level (UUIDs).

### Three Tools, Not One or Five

**We considered:**
- **One mega-tool** - Different modes for everything (too complex, unclear semantics)
- **Five granular tools** - Separate tools for each operation (too fragmented, decision paralysis)
- **Three semantic tools** - Each represents a distinct user intent ✓

**The three intents:**
1. **"Show me what's at this path"** → `view`
2. **"Show me the organizational structure"** → `tree`
3. **"Find documents matching this query"** → `search`

These map to how users naturally ask questions about their content.

### Implicit Project Context

**Decision:** Tools don't require `project_id` parameter.

**Why:**
- Chats are scoped to projects (`chat.project_id`)
- Backend already knows project context
- Reduces parameter count (simpler for LLM)
- Prevents errors (can't accidentally query wrong project)

The project context is injected by the backend during tool execution, invisible to the LLM.

---

## The Three Tools

### 1. `view` - Look at a Specific Path

**Purpose:** View what exists at a specific path - either a document's content or a folder's immediate contents.

**Behavior:**
- **If path is a document:** Returns full markdown content
- **If path is a folder:** Returns immediate children (one level deep) - subfolders and documents at this level only
- **If path is empty string (`""`):** Returns project root contents

**Why not deeper than one level?**  
That's what `tree` is for. `view` answers "what's here?", not "how is this organized?"

**Parameters:**
- `path` (string) - Path to view, empty string for root

**Example Questions This Answers:**
- "What's in my Characters folder?"
- "Read the Elara document"
- "What documents are at the root of my project?"

---

### 2. `tree` - Show Hierarchical Structure

**Purpose:** Get a nested view of folders and documents to understand organizational structure. Returns metadata only (no document content).

**Behavior:**
- Always returns hierarchical tree structure
- Traverses multiple levels (controlled by `depth`)
- Returns document/folder names, paths, word counts - but never document content
- Use this to understand "how is my project organized?" not to read content

**Why separate from `view`?**  
Different semantic intent:
- `view` = "Look at this thing" (content-focused)
- `tree` = "Show me structure" (organization-focused)

Combining them would fundamentally change return types and purposes based on a parameter - a sign they should be separate tools.

**Parameters:**
- `folder` (string) - Starting folder path, empty string for entire project
- `depth` (integer) - Levels to traverse (1-5, default: 2)

**Why "folder" not "path"?**  
Semantic precision. This tool only makes sense for folders, not documents. Using `folder` makes the constraint explicit and prevents confusion.

**Example Questions This Answers:**
- "How is my Worldbuilding section organized?"
- "Show me the full structure of my project"
- "What subfolders exist under Characters?"

---

### 3. `search` - Find Documents by Content

**Purpose:** Full-text search across document content and names. Returns matching documents ranked by relevance (metadata only).

**Behavior:**
- Searches document names and content
- Name matches weighted higher (2x) than content matches
- Returns metadata only (paths, names, word counts) - use `view` to read content
- Can optionally scope to a specific folder

**Why separate from `view`?**  
Completely different operation:
- `view` requires knowing the path
- `search` helps you discover paths you don't know

**Parameters:**
- `query` (string) - Search query
- `folder` (string, optional) - Scope search to this folder, empty string for entire project

**Why "folder" not "path"?**  
Same reasoning as `tree` - this parameter defines a folder boundary for search scope, not a specific path to view.

**Example Questions This Answers:**
- "Find all documents about dragons"
- "Where did I mention the betrayal scene?"
- "Search for 'magic system' in my Worldbuilding folder"

---

## Key Design Decisions

### Decision: Path-Based, Not UUID-Based

**What we rejected:**
```
view_file(document_id="uuid-123")
view_tree(folder_id="uuid-456")
```

**What we chose:**
```
view(path="Characters/Elara")
tree(folder="Characters")
```

**Why:**
- Paths are how users think about their documents
- Eliminates multi-step UUID lookup ("what's the UUID for Characters?")
- Reduces tool calls dramatically (7+ calls → 1 call for nested navigation)
- Aligns with existing API path notation support

**Trade-off:**  
Backend must resolve paths to entities. Worth it for better UX.

### Decision: `tree` vs `view(tree=true)`

**What we considered:**
```
view(path, tree=true, tree_depth=2)
```

**What we chose:**
```
view(path)
tree(folder, depth=2)
```

**Why:**
- "View" semantically means "look at this thing's content"
- "Tree" semantically means "show me organizational structure"
- A `tree` boolean fundamentally changes the tool's purpose and return type
- When a parameter changes the fundamental meaning, it should be a separate tool

**The test:** If a parameter makes you return completely different data structures for completely different purposes, it should be a separate tool.

### Decision: `view` Returns Different Structures - Why That's Not "Dual Behavior"

**The Apparent Tension:**
Our design principle states: "If a parameter makes you return completely different data structures for completely different purposes, it should be a separate tool."

Yet `view(path)` returns different structures:
- Document: `{type: "document", content: "...", path: "...", ...}`
- Folder: `{type: "folder", documents: [...], folders: [...], ...}`

**Why This Doesn't Violate The Principle:**

1. **Same Semantic Purpose**: "Show me what's at this path"
   - Not "view document" vs "list folder" (different purposes)
   - Just "inspect this location" (single purpose)

2. **Appropriate Response Pattern**: Like `ls` in Unix
   - `ls file.txt` shows file info
   - `ls directory/` shows directory contents
   - Same operation, appropriate responses

3. **The Key Test**: Is it a parameter changing the behavior?
   - ❌ No - there's no `mode=` or `type=` parameter
   - ✅ The path itself determines what exists there
   - The tool behaves consistently: "return what's at this location"

4. **Future-Proof**: When we add folder metadata
   - `view(path="Characters")` will also return folder description, README, etc.
   - Still the same operation: "show me everything about this location"

**Contrast With True Dual Behavior:**
If we had `view(path, mode="content"|"structure")`, that WOULD violate the principle - a parameter fundamentally changing the purpose.

**Summary**: `view` has one behavior (inspect path), with appropriate responses based on what exists there. The structure varies, but the semantic intent remains constant.

### Decision: Simple Names Without Prefixes

**What we rejected:**
```
view_file, view_folder, view_tree, search_document
```

**What we chose:**
```
view, tree, search
```

**Why:**
- Shorter, cleaner
- Matches Unix conventions (`tree`, `grep`/`search`)
- Context makes purpose obvious (in a document system, "search" clearly means search documents)
- Consistent style: all single-word verbs/nouns

### Decision: No Folder Metadata (Yet)

**What we considered:**
- Folder descriptions
- Folder README files
- `include_readme` parameter

**What we chose:**  
Skip it for MVP. If users need folder documentation, they can create a `README.md` document in that folder.

**Why:**
- Avoids premature complexity
- READMEs as documents reuse all existing document logic
- Can add dedicated folder metadata later if needed
- YAGNI (You Aren't Gonna Need It)

### Decision: Optional Folder Scoping for Search

**What we chose:**
```
search(query, folder="")  // Empty = search all
```

**Why:**
- Useful for large projects ("search just my Worldbuilding folder")
- Makes all three tools consistent (all accept folder/path)
- Default (empty string) searches everything - simple case stays simple
- Future-proofs for scaling (when projects have 500+ documents)

**Trade-off:**  
Adds a parameter. Worth it for consistency and future scalability.

---

## Usage Patterns

### Pattern 1: Navigation
```
User: "What's in my Characters folder?"
LLM: view(path="Characters")
→ Returns list of documents/subfolders at this level
```

### Pattern 2: Reading Content
```
User: "Read the Elara character document"
LLM: view(path="Characters/Elara")
→ Returns full document markdown content
```

### Pattern 3: Understanding Structure
```
User: "How is my project organized?"
LLM: tree(folder="", depth=2)
→ Returns nested tree of entire project (2 levels deep)
```

### Pattern 4: Finding Content
```
User: "Where did I write about dragons?"
LLM: search(query="dragon")
→ Returns matching documents with metadata
LLM: view(path="Worldbuilding/Creatures/Dragons")
→ Reads specific document to answer question
```

### Pattern 5: Scoped Exploration
```
User: "Find all mentions of betrayal in my plot outlines"
LLM: search(query="betrayal", folder="Plot/Outlines")
→ Returns matches scoped to that folder only
```

### Pattern 6: Multi-Step Discovery
```
User: "Tell me about the character who owns the magic sword"
LLM: search(query="magic sword")
→ Finds "Items/Weapons/Dawnblade" mentions sword owner
LLM: view(path="Items/Weapons/Dawnblade")
→ Reads document: "Owned by Kael Stormborn"
LLM: view(path="Characters/Kael Stormborn")
→ Reads character document
→ Responds with character details
```

---

## What We're NOT Building (Yet)

### Document Editing
- No `create_document`, `update_document`, `delete_document`
- Read-only tools only for MVP
- Editing comes later (Backend-10)

### Advanced Search Features
- No vector/semantic search (future enhancement)
- No search result ranking customization
- No fuzzy matching or typo tolerance
- Basic PostgreSQL full-text search is sufficient for MVP

### Folder Metadata
- No folder descriptions or READMEs
- Users can create `README.md` documents if needed
- Can add dedicated folder metadata later

### Large Document Handling
- No pagination or partial content viewing
- Documents returned in full
- Future: Add `view_range` or chunking if documents exceed token limits

### Multi-Project Operations
- Tools work within single project context (from chat)
- No cross-project search or viewing
- Each chat is scoped to one project

---

## Future Considerations

### When Projects Scale
- **Problem:** 500+ documents, deep nesting
- **Solution:** Consider caching `tree` results, add pagination to search

### When Documents Grow Large
- **Problem:** Single document exceeds token limits
- **Solution:** Add `view(path, start_char, end_char)` for partial viewing

### When Users Want Semantic Search
- **Problem:** FTS doesn't understand concepts ("find documents about character development")
- **Solution:** Add vector embeddings, keep `search` interface the same (backend swap)

### When Folder Context Matters
- **Problem:** Users want to document folder purposes
- **Solution:** Add folder `description` field, or special README support

### When Users Need Editing
- **Problem:** LLM needs to modify documents
- **Solution:** Add `suggest_edits` tool (structured diff format, not direct writes)

---

## Success Criteria

**We'll know this design works when:**
- ✅ LLM can navigate project structure in 1-3 tool calls (not 7+)
- ✅ Users can ask "show me X" and LLM finds it efficiently
- ✅ Tool names/parameters are self-explanatory (no confusion)
- ✅ 90% of queries use `view` and `search` (core operations)
- ✅ `tree` used sparingly (structural overview, not routine navigation)
- ✅ Implementation is straightforward (no architectural gymnastics)

**We'll know we need to iterate when:**
- ❌ LLM frequently picks wrong tool for task
- ❌ Users frustrated by multi-step navigation
- ❌ Token limits hit frequently (documents too large)
- ❌ Search returns poor results (need semantic search)

---

## Summary

**Three tools, three intents:**
- **`view(path)`** - Look at this thing
- **`tree(folder, depth)`** - Show me structure
- **`search(query, folder)`** - Find by content

**Core principles:**
- Path-centric (matches user mental model)
- Project context implicit (from chat)
- Semantic clarity (each tool has distinct purpose)
- Start simple, add complexity when needed

**Why this works:**
- Maps to natural language queries
- Minimizes tool calls through path-based access
- Clear boundaries between tools
- Room to grow (search improvements, editing, metadata)

Ship the MVP, learn from usage, iterate based on real needs.