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

Writer: "This is magical."
```

**That's the MVP.**

---

## The Three Core Systems

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
- Store TipTap JSON (for editor)
- Generate Markdown (for AI + search)
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
- Cache chunks to Redis
- Save to database when complete
- Reconnection pulls from cache + continues

---

## Development Phases

### Phase 1: File System (Week 1-2)

**Backend:**
- Go + Fiber server setup
- Supabase connection (PostgreSQL)
- Document CRUD endpoints
- Store both TipTap JSON and Markdown
- Full-text search indexing
- Deploy to Railway

**Frontend:**
- Next.js + TypeScript setup
- TipTap editor integration
- Document tree component
- Auto-save implementation
- API client for backend
- Deploy to Vercel

**Deliverable:** Can create, organize, and edit documents. No AI yet.

### Phase 2: AI Integration (Week 3-4)

**Backend:**
- Multi-provider AI interface
- Claude provider implementation
- OpenAI provider implementation
- Simple context builder:
  - Load current document
  - Full-text search across documents
  - Rank results
  - Build prompt
- Streaming endpoint (SSE)

**Frontend:**
- Chat panel component
- Provider selector
- Skill selector
- Message display
- SSE streaming client

**Deliverable:** Can chat with AI, AI has context from full-text search.

**Test:** 
- Write about "Elara" in one document
- Create Characters/Elara document
- Ask AI about Elara
- Verify AI loaded Characters/Elara via search

### Phase 3: Persistent Streaming (Week 4-5)

**Backend:**
- Stream manager with goroutines
- Redis caching for chunks
- Session management
- Reconnection logic
- Cleanup on completion

**Frontend:**
- Store session IDs
- Reconnection handling
- Resume from cache
- Show stream status

**Deliverable:** Streams persist server-side, reconnection works.

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

### Why Store Both TipTap JSON and Markdown?

**TipTap JSON:**
- Editor needs it to render
- Preserves formatting

**Markdown:**
- Cleaner for AI
- Better for search
- Easy to export

**Generate Markdown automatically on save.**

### Why Go for Backend?

Persistent streaming needs goroutines. Go makes it simple. Python needs Celery + workers + complexity.

---

## Data Models

### Document
```
id: UUID
project_id: UUID
path: string (e.g., "Characters/Elara")
content_tiptap: text (TipTap JSON)
content_markdown: text (generated from TipTap)
word_count: int
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

### Stream Session (Redis)
```
session_id: string
user_id: string
document_id: string
chunks: array
status: string (active, complete, error)
```

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

---

## Success Criteria

### Technical Success
- Documents persist correctly
- Both formats stored
- Search returns relevant results
- AI responses include context from search
- Streaming works
- Reconnection works
- No data loss

### User Success
- Writer creates 20+ documents
- Writer asks 10+ AI questions
- AI demonstrates context knowledge
- Writer says "this is helpful"
- Writer wants to keep using it

### Validation Success
- 5+ beta writers test
- 3+ want to keep using
- Clear next steps
- Launch or pivot decision

---

## What We're NOT Building Yet

**Save for post-MVP:**
- @-reference syntax (optional explicit references)
- Manual context additions
- RAG/embeddings (full-text search first)
- Multiple chat threads
- Collaboration
- Version history
- Export
- Advanced search
- Graph visualization

**Focus:** Core loop only.

---

## The MVP Loop

```
1. Writer creates documents
2. Writer writes naturally
3. Writer asks AI questions
4. AI searches all documents
5. AI responds with full context
6. Writer: "This is helpful!"
```
