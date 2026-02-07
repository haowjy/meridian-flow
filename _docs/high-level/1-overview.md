---
title: Product Overview
description: What Meridian can do RIGHT NOW
created_at: 2025-10-30
updated_at: 2026-02-05
author: Jimmy Yao
category: high-level
tracked: true
---

# Meridian: Product Overview

**Claude Code, but for writers.**

An agentic AI writing platform that brings the sophistication of modern coding tools to creative writing. While other writing tools offer simple AI assistance, Meridian gives you the same powerful agentic workflows that revolutionized software development.

---

## What You Can Do Today

### Write with AI That Knows Your Entire Project

**Automatic context discovery** - AI searches across all your documents to understand your complete project:

```
You: "Is this scene consistent with Elara's character?"

AI automatically:
├─ Searches for "Elara" across all documents
├─ Reads your Characters/Elara document
├─ Finds all chapters mentioning Elara
└─ Responds with full project context
```

**Streaming responses with real-time updates** - See AI thinking as it works, not just the final answer. Send follow-up questions while AI is still thinking to refine direction (interjection).

### Edit Documents with AI Assistance

**Inline editing workflow** - AI suggests changes you can review before accepting:

```
You: "Make this dialogue more cynical"

AI:
├─ Creates suggested edits
├─ Shows changes with inline diff view
└─ You accept/reject with full undo support

OR: "Make it shorter too"
    └─ AI refines suggestion (iterative improvement)
```

**Safe concurrent editing** - AI and human can work simultaneously with automatic conflict detection (CAS concurrency control).

**Powerful tools** - AI can autonomously:
- `str_replace_based_edit_tool` - View, create, and edit documents with inline diff preview
- `doc_search` - Full-text search across all files
- `web_search` - Look up information online

### Organize Your Writing Project

**Document tree** - Folders and markdown documents, just like a code editor.

**Multi-format import** - Drop in `.zip` archives, `.md`, `.txt`, or `.html` files. XSS sanitization keeps you safe.

**Auto-save** - Never lose work. Changes save automatically after 1 second of inactivity.

**Mobile responsive** - Full interface works on phones and tablets with bottom tab navigation.

**Word count** - Track your progress at a glance.

### Customize AI Behavior with Skills

**Skills** - Custom AI commands you can create and reuse:

```
Example: "cw-prose-writing" skill
- Instructions for fiction prose style
- Voice and tone guidelines
- Story structure preferences
```

**Full-screen markdown editor** - Write and edit skill instructions with auto-save.

**Tree integration** - Skills appear in your project tree for easy access.

---

## What Makes Meridian Different?

**"Claude Code for Writers"** - We bring agentic coding sophistication to creative writing.

### vs Writing Tools (NovelCrafter, Sudowrite, NovelAI)

**They have**: Simple AI tools, character databases, prompted workflows

**We have**:
- **Agentic AI** - AI autonomously explores your project, not just database lookup
- **Tool calling architecture** - AI searches, reads, and edits across documents without prompting
- **Inline diff editing** - Review changes with visual diff, accept/reject, full undo
- **CAS concurrency** - Safe simultaneous editing (enterprise-grade conflict detection)
- **Streaming responses** - See AI thinking in real-time, send follow-ups mid-stream

### vs General AI (ChatGPT, Claude.ai)

**They have**: Great LLMs, but no project persistence

**We have**:
- **Persistent file system** - AI never forgets your project
- **Direct document editing** - No copy-paste workflow
- **Multi-document context** - AI searches across everything automatically
- **Tool calling** - AI can explore your project autonomously

**Better for**: Long-form projects where AI needs to remember everything.

### vs Developer Tools (Claude Code, Cursor)

**They're for**: Developers writing code

**We're for**: Writers crafting stories

**Same power**: Agentic AI with tool calling, but writer-friendly UX.

---

## Technical Differentiators

**What NO writing tool competitor has:**
1. **Agentic coding patterns for writers** - Claude Code/Cursor sophistication adapted for creative work
2. **CAS concurrency control** - Safe concurrent editing with version tokens (enterprise-grade)
3. **CodeMirror PUA marker system** - Inline diff view with accept/reject + full undo
4. **Tool calling architecture** - AI autonomously searches, reads, edits across documents

**What sets us apart:**
5. **Multi-provider design** - 3 providers (Anthropic, OpenRouter, Lorem), easy to add more
6. **Skills system** - User-extensible AI behaviors (competitors have fixed tools)
7. **Mobile responsive** - Actually works well on phones/tablets (competitors are desktop-only)
8. **Markdown-native storage** - Single source of truth, no format conversion

---

## Technical Architecture

**Stack:**
- **Frontend**: Vite + TanStack Router + TypeScript + CodeMirror
- **Backend**: Go + net/http (for persistent streaming)
- **Database**: Supabase (PostgreSQL + Auth)
- **AI Providers**: Anthropic (Claude), OpenRouter (multiple models), Lorem (testing)
- **Deployment**: Vercel (frontend) + Railway (backend)

**Key technical features:**
- **Markdown storage** - Single source of truth, clean and portable
- **Turn branching** - Navigate conversation history like a tree
- **Server-Sent Events (SSE)** - Real-time streaming with catchup/reconnection
- **Tool registry** - Extensible tool system with auto-mapping to provider formats
- **JWT authentication** - Secure with Google OAuth integration

For detailed architecture, see [`_docs/technical/`](../technical/).

---

## Current Limitations

**What's not built yet:**

- **Search UI** - Backend search works, but frontend UI filters are non-functional
- **@-references** - Backend supports document references, no frontend autocomplete UI yet
- **Multi-document batch editing** - AI can only suggest edits to one document at a time
- **Skills invocation in chat** - Skills exist but can't be triggered during conversation yet
- **User preferences UI** - Settings API complete, but preferences UI not yet implemented
- **System prompt UI** - Backend supports custom system prompts, no frontend UI
- **Additional LLM providers** - OpenAI and Google Gemini planned but not yet integrated
- **User settings preferences** - Profile UI complete, but preference configuration pending

**These are on the roadmap.** The core agentic workflow (context discovery, tool calling, inline editing) is production-ready.

---

## Roadmap

See [Vision Document](./3-vision.md) for future plans:
- **Agent framework** - Parallel work streams, subagents, thread branching
- **Skill marketplace** - Share custom AI behaviors with the community
- **Publishing integration** - Direct to Royal Road, Wattpad, etc.

For detailed feature status, see [`_docs/features/README.md`](../features/README.md).

---

## Getting Started

**Authentication:** Google OAuth only (simplified auth flow)

**Create a project:** Import existing files or start fresh

**Write naturally:** Just create documents and start writing

**Ask AI anything:** AI automatically discovers context across your project

**Accept AI suggestions:** Review inline edits with diff view before applying

**For detailed documentation by stack:**
- **Backend**: [`backend/CLAUDE.md`](../../backend/CLAUDE.md)
- **Frontend**: [`frontend/CLAUDE.md`](../../frontend/CLAUDE.md)

---

## Status

**Current version:** MVP complete (February 2026)

**Backend:** ✅ Feature-complete for MVP - Auth, file system, thread/LLM, streaming, tool calling all working

**Frontend:** ✅ Feature-complete for MVP with high UI polish - All core features fully implemented

**Integration:** ✅ Backend and frontend fully integrated (~35 endpoints, all functional)

For implementation status by feature, see [`_docs/features/README.md`](../features/README.md).
