---
detail: standard
audience: architect
---

# Frontend Workspace Modes

**Status:** draft

## Purpose

Refactor the desktop rail around three distinct ways of working:

| Rail item | Primary question | Primary surface |
|---|---|---|
| `Agents` | What is happening across this writing session? | Session orchestration |
| `Converse` | What am I discussing with the assistant right now? | Single active thread |
| `Studio` | What am I changing in the workspace right now? | Filesystem-backed editor |

The goal is not to add more navigation. The goal is to stop one layout from trying to serve three different jobs at once.

## Why These Modes Stay Separate

| Mode | Why it is separate | What breaks if merged back together |
|---|---|---|
| `Agents` | Multi-thread orchestration needs session awareness, parallel visibility, and handoff surfaces. | It turns ordinary chat into a control room and overloads the main conversation UI. |
| `Converse` | Deep collaboration with one thread works best when chat is center stage and tool use feels immediate. | The thread loses focus and becomes subordinate to navigation chrome. |
| `Studio` | Editing needs a stable filesystem view, a large document canvas, and inline review in place. | The editor becomes cramped and document work feels secondary to chat. |

This split preserves one clear primary canvas per mode.

## Shared Principles

- The rail switches work modes, not random panels.
- The filesystem remains the substrate for workspace organization.
- Top-level folder names remain the main visible taxonomy in document work.
- `Converse` preserves the current chat-first rhythm and tool usage model.
- `Studio` remains the canonical place for inline document review and proposal hunks.
- `Agents` is session-first: a session contains multiple related threads, including branches and spawned agent threads.

## Mode Summaries

### `Agents`

**Purpose:** oversee a writing session that may contain multiple active threads and delegated agent work.

**Main feature set:**
- Session-level overview
- Thread family visibility
- Parallel activity monitoring
- Handoff and status surfaces
- Fast drill-in to a single thread

**Why it exists:** writers need a place to supervise parallel work without losing the main drafting or discussion surface.

### `Converse`

**Purpose:** work deeply with one thread.

**Main feature set:**
- Active thread as the center canvas
- Fast assistant interaction
- Tool usage in-thread
- Lightweight document context
- Focused review access without leaving the conversation

**Why it exists:** the writer needs one place where discussion, guidance, brainstorming, and direct assistant interaction feel immediate.

### `Studio`

**Purpose:** edit and explore the workspace directly.

**Main feature set:**
- Filesystem-grounded navigation
- Large editor canvas
- Inline proposal and hunk review
- Assistant as supporting sidecar
- Fast movement between documents

**Why it exists:** writing and revision need a stable editor-first environment, not a chat-first compromise.

## Writer Profiles

| Writer profile | `Agents` helps by | `Converse` helps by | `Studio` helps by |
|---|---|---|---|
| Serial fiction writer | Tracking chapter planning, continuity, and background threads in one session | Working through scene problems, voice, and chapter feedback in one thread | Revising chapters and reviewing inline changes directly in the manuscript |
| Revision-heavy writer | Monitoring separate critique, rewrite, and polish threads | Negotiating one revision path at a time with the assistant | Accepting, rejecting, and editing changes where they land in the text |
| Research-driven writer | Coordinating source-gathering, synthesis, and question threads | Testing arguments, summaries, and structure in focused dialogue | Organizing notes and drafts using the project’s actual folder structure |
| Exploratory writer | Letting multiple ideas run in parallel without losing the main thread | Brainstorming freely without the workspace feeling technical | Converting promising threads into concrete documents and outlines |

The shell stays writer-first, but the taxonomy stays flexible because project structure still comes from the writer's folders.

## Specs

| Spec | Purpose |
|---|---|
| [Layout Architecture](spec/layout-architecture.md) | Converse/Studio panel layouts, mode switching, state scoping |
| [Collab v2 Integration](spec/collab-v2-integration.md) | Inline review, hunk toolbar, proposal quick actions, decoration layers |
| [Studio Chrome](spec/studio-chrome.md) | Tab bar, file explorer, tab lifecycle |
| [Editor Direction](spec/editor-direction.md) | CM6 live preview rebuild, decoration architecture, formatting toolbar |

## Frontend v2 Approach

The workspace modes are being built as part of `frontend-v2/`, a ground-up rebuild using Storybook-first development. Components are mode-agnostic; only the layout shells are mode-aware. See `frontend-v2/CLAUDE.md` for build phases.

## Non-Goals

- Defining exact pane counts or exact tab layouts
- Locking in specific component implementations
- Replacing the filesystem with a hidden schema
- Turning Meridian into a generic IDE shell

## Result

This refactor gives Meridian three intentional work modes:

- `Agents` for orchestration
- `Converse` for focused collaboration
- `Studio` for direct document work

That separation reduces layout compromise, keeps the product writer-first, and still leaves room for different writing styles and project structures.
