---
title: MVP Specification
description: What We're Building and How
created_at: 2025-10-30
updated_at: 2025-10-30
author: Jimmy Yao
category: high-level
tracked: true
---

# Meridian: MVP Specification

**What We're Building and How**

---

## MVP Goal

**Validate:** Does AI with full project context help fiction writers maintain story consistency?

**How:** 10 writers use it for 2 weeks, 3+ say "I want to keep using this"

**Timeline:** 6-8 weeks to testable product

---

## What We're Building

### Core Experience

```
Writer opens Meridian
├── Sees document tree (left)
├── Edits document (center)
└── Chats with AI (right)

Writer creates documents:
├── Characters/Elara
├── Locations/The Capital
└── Chapters/Chapter 1

Writer writes in Chapter 1:
"Elara walked through the capital..."

Writer asks AI:
"Is this scene consistent with Elara's character?"

AI automatically:
├── Reads Chapter 1 (current document)
├── Full-text search for "Elara" across all documents
├── Loads Characters/Elara document
├── Loads any other docs mentioning Elara
└── Responds with full context

Writer asks AI:
"Make her dialogue more cynical"

AI:
├── Creates version snapshot
├── Suggests edits to dialogue
└── Shows suggestion in chat

Writer:
├── Clicks "Review" → sees diff
├── Accepts changes
└── Document updated

Writer: "This is magical."
```

**That's the MVP.**

---

## The Four Core Systems

### 1. File Management

**What users see:**
- Document tree (folders + documents)
- Click document → opens in editor (single view, one document at a time)
- Create/rename/delete/move documents
- Rich text editing (bold, italic, headings, lists)
- Auto-save (every 2 seconds after typing stops)
- Word count

**MVP simplification:**
- Single document view (no tabs)
- Clicking new document saves current and loads new one
- Keeps MVP focused and simple
- Tabs can be added in Phase 1.5 if needed

**What happens behind the scenes:**
- Store Markdown (single source of truth)
- Frontend converts to/from editor format
- Full-text search index
- Document metadata (created, modified, word count)

### 2. AI Context Building

**What users see:**
- Type naturally in any document
- Ask AI questions in chat
- AI responds with knowledge of entire project
- Optional: Context panel showing what AI loaded

**What happens behind the scenes:**
- User asks question in context of current document
- **Simple approach:** Full-text search for key terms from question + current document
- Load top N matching documents
- Build prompt with: skill + current doc + matched docs
- Stream response

**Context discovery for MVP:**
- Full-text search (Postgres `to_tsvector`)
- Search current document + question for important terms
- Rank by relevance (TF-IDF or simple scoring)
- Load top 5-10 documents
- Total context budget: ~50-100K tokens

**Optional future:** 
- RAG with embeddings
- Better entity extraction
- Semantic search
- But full-text search is enough to validate

### 3. Persistent Streaming

**What users see:**
- Send message to AI
- See response stream in
- Can close browser
- Come back later
- Response completed or still generating

**What happens behind the scenes:**
- Create stream session in Go
- Launch goroutine for AI call
- Cache chunks in-memory (buffer)
- Save to database when complete
- Reconnection pulls from database + continues (catchup)

### 4. AI Tools & Editing

**What users see:**
- Ask AI to find information → AI searches and reads documents autonomously
- Ask AI to improve writing → AI suggests edits
- Review suggestions side-by-side
- Accept or reject changes
- AI can iterate on feedback

**What happens behind the scenes:**
- **Read-only tools** AI uses during conversation:
  - `view_file` - Fetch document content by ID
  - `get_tree` - List documents in folder
  - `search_documents` - Full-text search across project
- **Editing tool**:
  - `suggest_document_edits` - AI proposes changes to a document
- **Version snapshots**:
  - Snapshot document when AI starts editing
  - Track what AI saw vs current state
  - Handle concurrent editing (user keeps working while AI generates)
- **Accept/reject workflow**:
  - AI creates version (doesn't modify live document)
  - User reviews diff in editor
  - Accept → applies changes, Reject → discards
  - Can iterate: "make it shorter" → AI refines suggestion

**Example flow:**
```
User: "Make this paragraph more formal"

AI:
1. Creates snapshot of current document
2. Generates suggested edits
3. Returns version for review

User sees:
- Suggestion card in chat
- Click "Review" → opens diff view
- Accept → document updated
- OR: "Make it shorter too"
  → AI refines suggestion (v2 → v3)
```

**MVP0 scope: Single-document editing only**
- AI suggests edits to ONE document at a time
- Multi-document batch editing deferred to post-MVP

---

## Development Phases

### Phase 1: File System (Week 1-2) ✅ Complete

**Backend:** ✅ All Complete
- ✅ Go + net/http server setup
- ✅ Supabase connection (PostgreSQL)
- ✅ Document CRUD endpoints
- ✅ Store Markdown (frontend handles editor conversion)
- ✅ Full-text search indexing
- ✅ Deploy to Railway

**Frontend:** ✅ Complete
- ✅ Next.js + TypeScript setup
- ✅ CodeMirror editor integration
- ✅ Document tree component
- ✅ Auto-save implementation
- ✅ API client for backend
- ❌ Deploy to Vercel (pending)

**Deliverable:** ✅ Backend: Can create, organize, and edit documents. Frontend in progress.

### Phase 2: AI Integration (Week 3-4) ✅ Backend Complete | ❌ Frontend Not Started

**Backend:** ✅ Complete
- ✅ Multi-provider AI interface (LLMProvider abstraction)
- ✅ Provider registry system
- ✅ Claude provider implementation (Anthropic)
- ✅ Chat CRUD operations (create, read, update, delete)
- ✅ Turn tree structure with branching support
- ✅ JSONB content blocks (text, thinking, tool_use, references)
- ✅ Request parameters (temperature, thinking, top-k, model)
- ✅ Streaming endpoint (SSE) with multi-client support
- ✅ Real-time delta events via Server-Sent Events
- ✅ TurnBlockDelta accumulation and TurnBlock persistence
- ❌ OpenAI provider implementation (planned)
- ❌ Google Gemini provider implementation (planned)
- ❌ Simple context builder (full-text search integration) (planned)

**Frontend:** ❌ Not Started
- ❌ Chat panel component
- ❌ Provider selector
- ❌ Skill selector
- ❌ Message display
- ❌ SSE streaming client

**Current Status:** Backend chat system fully functional with streaming LLM responses. Frontend chat UI pending.

**Deliverable:** ✅ Backend complete with streaming. Frontend chat UI pending.

**Test:** 
- Write about "Elara" in one document
- Create Characters/Elara document
- Ask AI about Elara
- Verify AI loaded Characters/Elara via search

### Phase 3: Persistent Streaming (Week 4-5) ✅ Backend Complete | ❌ Frontend Not Started

**Backend:** ✅ Complete
- ✅ Stream manager with goroutines (TurnExecutor + Registry)
- ✅ In-memory + database two-tier catchup (no Redis needed)
- ✅ Session management (stream registry with automatic cleanup)
- ✅ Reconnection logic (Last-Event-ID catchup)
- ✅ Cleanup on completion (automatic goroutine lifecycle)
- ✅ Race condition fixes (atomic PersistAndClear, catchup mutex)
- ✅ Multi-client support (one stream → many SSE connections)

**Frontend:** ❌ Not Started
- ❌ Store session IDs
- ❌ Reconnection handling
- ❌ Resume from catchup
- ❌ Show stream status

**Deliverable:** ✅ Backend complete with catchup working. Frontend reconnection UI pending.

**Note:** Backend streaming architecture complete and verified working ("IT WORKS CATCHUP WORKS TOO!").

### Phase 4: Polish & Testing (Week 5-6)

**Focus areas:**
- Performance tuning
- UX polish (loading states, errors, confirmations)
- Search relevance tuning
- Bug fixes
- Edge cases

**Deliverable:** Polished, reliable product ready for beta.

### Phase 5: Beta Testing (Week 7-8)

- 5 writers from Royal Road
- Real usage for 2 weeks
- Daily feedback
- Iterate on critical issues
- Make launch decision

---

## Technical Decisions

### Context Building: Start Simple

**MVP approach:**
```
User asks: "Is Elara's dialogue consistent?"

1. Extract key terms: "Elara", "dialogue", "consistent"
2. Full-text search across all documents
3. Rank by relevance (how often terms appear)
4. Load top 5-10 documents
5. Add current document
6. Send all to AI
```

**Why this works:**
- Fast (Postgres full-text search is quick)
- Simple to implement
- Good enough for validation
- Can improve later

**Future improvements:**
- RAG with embeddings (semantic search)
- Better term extraction
- Learning from usage patterns
- But don't need these for MVP

### Why Markdown Storage?

**Single source of truth:**
- Markdown stored in database
- CodeMirror works directly with markdown (no conversion needed)
- No synchronization issues

**Benefits:**
- Cleaner for AI consumption
- Better for full-text search
- Easy to export
- Simpler architecture

### Why Go for Backend?

Persistent streaming needs goroutines. Go makes it simple. Python needs Celery + workers + complexity.

---

## Data Models

### Document
```
id: UUID
project_id: UUID
folder_id: UUID (nullable, for folder hierarchy)
name: string (e.g., "Elara")
content: text (Markdown - single source of truth)
word_count: int (computed from markdown)
created_at: timestamp
updated_at: timestamp
```

### Project
```
id: UUID
user_id: UUID
name: string
created_at: timestamp
```

### Turn Blocks
```
id: UUID
turn_id: UUID
sequence: int (order within turn)
block_type: string (text, thinking, tool_use, tool_result, reference)
content: JSONB (flexible structure per block type)
created_at: timestamp
```

**Block types:**
- `text` - AI response text
- `thinking` - Extended thinking (Claude)
- `tool_use` - AI calling a tool (view_file, search_documents, suggest_document_edits)
- `tool_result` - Results from tool execution
- `reference` - Document references (scaffolded, not used in MVP0 UI)

### Document Version
```
id: UUID
document_id: UUID
parent_version_id: UUID (nullable, for version tree)
version_type: string (user_edit, ai_suggestion, manual_snapshot)
created_by_turn_id: UUID (nullable, links to chat turn)
content: text (Markdown snapshot)
content_hash: text (SHA256 for comparison)
description: text (what changed)
created_at: timestamp
```

**Used for:**
- AI suggestion snapshots (what AI saw when making edits)
- Accept/reject workflow (user reviews version diffs)
- Concurrent editing safety (user edits while AI works)

**MVP0 scope:**
- Only AI suggestions versioned
- NOT full version history of all user edits
- That's post-MVP

### Stream Session (In-Memory)
```
turn_id: UUID (primary key)
status: string (streaming, complete, error)
buffer: in-memory event buffer for catchup
registry: map of active streams (automatic cleanup)
persistence: events saved to database as blocks when complete
```

**Two-tier catchup:**
1. **In-memory buffer**: Fast catchup for recent connections (events buffered during streaming)
2. **Database**: Historical catchup when buffer unavailable (completed turns)

---

## API Endpoints

### Documents & Tree
```
GET    /api/projects/:projectId/tree
POST   /api/documents
GET    /api/documents/:id
PUT    /api/documents/:id
DELETE /api/documents/:id
```

### Search (internal for context)
```
POST   /api/search
Body: { query, projectId }
Returns: ranked document IDs
```

### Chat
```
POST   /api/chat
Body: { message, provider, skill, documentId }
Returns: { sessionId }

GET    /api/chat/:sessionId/stream
Returns: SSE stream
```

### AI Tools (Internal - Called by LLM during streaming)
```
Tool: view_file(document_id) → document content
Tool: get_tree(folder_id) → list of documents
Tool: search_documents(query) → ranked results
Tool: suggest_document_edits(document_id, edits) → version_id
```

### Document Versions
```
POST   /api/documents/:id/versions/:versionId/accept
POST   /api/documents/:id/versions/:versionId/reject
GET    /api/documents/:id/versions
GET    /api/versions/:id
```

---

## Success Criteria

### Technical Success
- Documents persist correctly
- Search returns relevant results
- AI responses include context from search
- **AI tools execute successfully** (view_file, get_tree, search_documents)
- **Tool results stream correctly** (tools execute during streaming)
- **Version snapshots persist** (AI suggestions saved as versions)
- **Suggestion workflow works** (create → review → accept/reject)
- **Diff viewer displays correctly** (side-by-side comparison)
- Streaming works
- Reconnection works
- No data loss

### User Success
- Writer creates 20+ documents
- Writer asks 10+ AI questions
- AI demonstrates context knowledge
- **Writer asks AI to improve writing** (AI editing workflow)
- **Writer reviews suggestions in diff view** (accept/reject flow)
- **Writer refines suggestions iteratively** ("make it shorter" → AI updates)
- Writer says "this is helpful"
- Writer wants to keep using it
- **Writer feels in control** (not scared of AI auto-editing)

### Validation Success
- 5+ beta writers test
- 3+ want to keep using
- Clear next steps
- Launch or pivot decision

---

## What We're NOT Building Yet

**Save for post-MVP:**

**Advanced AI Features:**
- Multi-document batch editing (AI updates multiple docs at once)
- Skills system (different AI behaviors for different tasks)
- Ideas → Lore → Story pipeline (three-phase workflow automation)
- Proactive AI suggestions (AI suggests without being asked)
- Advanced @-reference features (autocomplete, fuzzy search)

**Other Features:**
- Frontend reference handling (@-reference syntax - backend supports it, no UI yet)
- Manual context additions (drag docs into chat)
- RAG/embeddings (full-text search sufficient for MVP)
- Multiple chat threads
- Collaboration (multi-user)
- Full version history (only AI suggestions versioned, not all user edits)
- Export functionality
- Advanced search filters
- Graph visualization

**MVP0 Focus:**
- Single-document AI editing with review workflow
- AI tools for autonomous exploration (view, search, read)
- Simple full-text context discovery
- Persistent streaming
- Core file management

**The pattern:** Build foundation (tools + single-doc editing), expand later (multi-doc, skills, automation).

---

## The MVP0 Loop

**Core workflow:**

```
1. Writer creates documents
2. Writer writes naturally
3. Writer asks AI questions
   ├─ AI searches all documents (search_documents tool)
   ├─ AI reads specific docs (view_file tool)
   └─ AI responds with full context
4. Writer asks AI to improve writing
   ├─ AI creates version snapshot
   ├─ AI suggests edits (suggest_document_edits tool)
   └─ AI shows suggestion in chat
5. Writer reviews suggestion
   ├─ Opens diff viewer (side-by-side comparison)
   ├─ Accepts → document updated
   └─ OR refines: "make it shorter" → AI iterates
6. Writer: "This is magical!"
```

**Two modes:**
- **Q&A mode:** AI explores project, answers questions
- **Edit mode:** AI suggests improvements, writer reviews/accepts
