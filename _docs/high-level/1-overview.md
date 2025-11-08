---
title: Project Overview
description: Overview of the Meridian project
created_at: 2025-10-30
updated_at: 2025-10-30
author: Jimmy Yao
category: high-level
tracked: true
---

# Meridian: Project Overview

**AI-Powered Creative Documentation Assistant with Full Project Context**

---

## What Is Meridian?

Meridian is a cloud-based tool for managing complex creative projects through:

1. **File-based organization** - Like a code editor, but for any creative work
2. **Explicit dependencies** - Connect related documents to build context
3. **Agentic AI** - AI that actively explores and helps maintain your project
4. **Multi-provider support** - Choose Claude, GPT-4, or bring your own keys
5. **Persistent streaming** - AI continues working even if you close the browser

## The Core Problem

Creators working on complex projects face:
- **Consistency errors** - Lost details, contradictory information
- **Time waste** - 30% of time spent searching old content
- **Context limitations** - ChatGPT forgets your project, Google Docs has no AI
- **Organization chaos** - Notes scattered across multiple tools
- **Manual work** - Creating reference docs, maintaining consistency

**Initial focus:** Fiction writers (100+ chapter web serials)
**Long-term:** Any complex creative project (game dev, screenwriting, technical docs, product specs)

## The Solution

### For Creators Who Want To:

**Maintain Consistency:**
- AI understands your entire project through document connections
- Searches across all documents
- Catches contradictions before they become problems

**Save Time:**
- AI captures notes during brainstorming
- Auto-generates reference documentation
- Explores project connections autonomously

**Stay Organized:**
- Simple document tree (like folders, but smarter)
- Natural hierarchy that makes sense
- Everything in one place, cloud-synced

**Keep Control:**
- Choose your AI provider
- Bring your own API keys for privacy
- Own your data completely
- Export anytime

### What Makes It Different

**vs Google Docs:** Has AI that knows your project + better organization
**vs ChatGPT:** Maintains full project context + can explore your documents
**vs Notion:** Purpose-built for creative work + AI assistance + simpler
**vs Cursor/Claude Code:** Made for creators, not developers + rich text editing

## How It Works

### 1. Organize Your Project in Documents

No file extensions needed. Just natural names:

```
My Fantasy Novel/
├── Characters/
│   ├── Elara
│   └── Marcus
├── Locations/
│   └── The Capital
└── Chapters/
    ├── Chapter 1
    └── Chapter 2
```

**Documents are:**
- Rich text (like Google Docs)
- Can include formatting, images (future)
- Stored efficiently for both editor and AI

### 2. Define Document Dependencies

Each document can reference other documents it depends on:

```
Document: "Chapter 1"

References:
- Characters/Elara
- Characters/Marcus
- Locations/The Capital
```

**This tells the system:**
- This chapter needs context from these documents
- AI should read these when analyzing this chapter
- Build the dependency tree automatically

**Not for inline prose:**
You wouldn't write: "Elara walked into the @[tavern]"
That's just normal writing: "Elara walked into the tavern"

**References are for:**
- "This document depends on these other documents"
- "AI should know about these when helping with this document"
- Building context efficiently

### 3. AI Knows Your Entire Project

When you ask: *"Is this scene consistent with Elara's character?"*

AI automatically:
- Reads current document (Chapter 1)
- Sees references (Elara, Marcus, The Capital)
- Reads all referenced documents
- Analyzes consistency
- Gives informed feedback

**Or manually add context:**
- "Compare this chapter to chapters 5-10" → manually add those chapters
- "Check against all character documents" → manually add Characters/ folder
- Both auto and manual context work together

### 4. AI Takes Action

**Brainstorming:** Takes notes while you explore ideas
**Documentation:** Creates character profiles from your chapters
**Writing:** Drafts content based on your established material
**Critique:** Analyzes consistency, pacing, structure
**Search:** Finds all mentions of a character across documents

### 5. Choose Your AI

- Use Meridian's managed keys (simple, pay per tier)
- Or bring your own keys (privacy, cost control, unlimited)
- Switch between Claude, GPT-4, or others
- Use different providers for different tasks

## Target Users

**Starting with: Web Serial Fiction Writers**
- Publishing on Royal Road, Wattpad, etc.
- Writing 100-500+ chapters per story
- Tech-comfortable but not programmers
- Frustrated with current tools
- Willing to pay for productivity

**Expanding to:**
- Game developers (lore, mechanics, NPCs)
- Screenwriters (episodes, characters, plot)
- TTRPG worldbuilders (campaigns, locations, NPCs)
- Technical writers (docs, guides, APIs)
- Product managers (specs, requirements, features)

**The pattern:** Complex, interconnected documentation that needs consistency.

## File System Philosophy

### Just Documents

**Not files with extensions:**
- Name: "Elara" (not "elara.md")
- Name: "Chapter 1" (not "chapter_01.md")
- Name: "The Capital" (not "the_capital.md")

**Just rich text documents** like you'd create in any editor.

### Under The Hood

**Storage (you don't see this):**
- TipTap JSON (for editor rendering)
- Markdown (for AI consumption and search)
- Both generated automatically
- Document ID for references

**In the UI:**
- Clean document names
- Folder hierarchy
- Rich text editor
- Simple and intuitive

### References System

**Not inline in prose:**
```
❌ "Elara walked through @[The Capital] to find @[Marcus]"
```

**Separate references section:**
```
Document: "Chapter 1"

Content:
[Your prose here - no special syntax]

References (managed separately):
- Characters/Elara
- Characters/Marcus  
- Locations/The Capital
```

**Benefits:**
- Prose stays clean and natural
- References are explicit and manageable
- AI builds context tree efficiently
- No need to pollute writing with syntax

**How to add references:**
- While editing: "Add reference" button/panel
- From file tree: Right-click → "Add as reference to current document"
- AI suggestions: "This document mentions Elara - add her character file as reference?"

### Why This Matters

**For writers:**
- Write naturally, no special syntax in prose
- References are metadata, not content
- Easy to see what a document depends on

**For AI:**
- Clear dependency graph
- Efficient context building
- No parsing prose for references
- Direct access to dependency tree

**For the system:**
- Can validate references
- Can suggest missing references
- Can show "what depends on this?"
- Can build relationship graphs

## Business Model

### Free Tier
- 1 project
- 10 AI messages/day
- All core features
- 100MB storage

### Creator Tier - $20/month
- Unlimited projects
- 300 AI messages/day
- Managed AI keys
- 1GB storage

### BYOK Tier - $5-10/month
- Unlimited projects
- Unlimited messages (you pay AI directly)
- Your own API keys
- Full privacy
- 1GB storage

### Economics
- **Managed:** ~$3 cost, $20 revenue = 85% margin
- **BYOK:** ~$0.50 cost, $5-10 revenue = 90-95% margin
- **Break-even:** 20 paying users
- **Sustainable:** 100+ paying users

## Technical Approach

### Stack
- **Frontend:** Next.js + TypeScript + TipTap
- **Backend:** Go + Fiber (for persistent streaming)
- **Database:** Supabase (PostgreSQL + Auth)
- **AI:** Multi-provider (Claude, OpenAI, etc.)
- **Deploy:** Vercel (frontend) + Railway (backend)

### Why Go?
Persistent streaming is core - users can close browser, AI keeps working. Go makes this trivial with goroutines. Python would require complex background task management.

### Key Technical Features
- **Dual storage:** TipTap JSON (editor) + Markdown (AI/search)
- **Document references:** Explicit dependency graph, not inline syntax
- **Persistent streaming:** Background goroutines continue AI generation
- **Multi-provider:** Abstract interface, easy to add new AI providers
- **BYOK:** Encrypted key storage, full privacy
- **Tools:** AI can search documents, read content, create documentation

## Success Criteria

### MVP Validation (Week 8)
- 5+ beta users actively using it
- 3+ say they want to keep using it
- Users organize projects naturally in documents
- Users understand reference system
- AI responses demonstrate full context
- No critical bugs or data loss

### Launch Success (Month 3)
- 50+ total users
- 20+ paying users ($400+ MRR)
- 70%+ weekly active rate
- Clear product-market fit

### Growth (Month 6)
- 200+ total users
- 100+ paying users ($2000+ MRR)
- Sustainable operation
- Organic growth

## Founder Advantages

1. **Has published Royal Road story** - Built-in audience
2. **Already validated concept** - Used Cursor/Claude Code for own writing
3. **Has custom writing skills** - cw-prose-writing, cw-brainstorm-capture, etc.
4. **Understands creator pain** - Personally experienced the problem
5. **Technical capability** - Can build it solo

## Timeline

- **Weeks 1-6:** Build MVP
- **Weeks 7-8:** Beta test with 5 writers
- **Month 3:** Launch decision based on validation
- **Months 4-6:** Grow to 100+ paying users

## The Opportunity

Creative documentation is universal. Fiction writing is just the wedge:
- $10B+ fiction market
- Exploding web serial growth
- No good tools exist
- Pattern applies to game dev, screenwriting, docs, product specs
