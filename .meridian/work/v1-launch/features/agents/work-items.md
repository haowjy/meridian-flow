# Work Items: Multi-Thread Work Context

## Concept

A work item is a named context that groups multiple threads and shared artifacts. It maps directly to the meridian CLI's `meridian work` — same abstraction, same terminology, same lifecycle.

Writers create work items for focused tasks: "Revise Arc 3," "Worldbuilding pass," "Fix continuity chapters 40-55." Each work item can have multiple threads (agents) running concurrently, sharing artifacts in a common workspace.

## CLI ↔ Flow Mapping

| CLI | Flow | Notes |
|-----|------|-------|
| `meridian work start "name"` | Create work item | Named context for grouped work |
| `$MERIDIAN_WORK_DIR` | Work item's artifact space | Shared FS for threads in this work item |
| `meridian spawn -a agent` | Create thread with agent profile | Thread belongs to a work item |
| Multiple spawns in parallel | Multiple concurrent threads | Agents working simultaneously |
| `meridian work done` | Complete/archive | Artifacts archived, threads closed |
| `meridian work` (dashboard) | Work items panel | Overview of active/completed work |

## Data Model

### Work Item
- `id`, `project_id`, `name`, `status` (active, done, archived)
- Owns: multiple threads, an artifact folder in the document tree
- Artifact folder: `.meridian/work/<work-item-slug>/` in the document tree (hidden from explorer, like `.agents/`)

### Thread → Work Item Relationship
- Each thread belongs to a work item (nullable for backward compat — standalone threads still work)
- Threads within a work item can read/write to the shared artifact space
- Agent profile selection is per-thread (different agents in the same work item)

## Artifact Space

Each work item gets a folder in the document tree:

```
.meridian/work/
├── revise-arc-3/
│   ├── notes.md              # Agent-created artifact
│   ├── continuity-issues.md  # Shared between threads
│   └── chapter-outline.md
└── worldbuilding-pass/
    ├── location-map.md
    └── timeline.md
```

- Hidden from explorer (same pattern as `.agents/`)
- Surfaced through the work item's detail view in the UI
- Threads can read/write these as tool operations
- Archived when work item is completed (read-only, still accessible)

## v1 Scope

### In
- Work item CRUD (create, list, show, complete, reopen)
- Multiple threads per work item
- Shared artifact space per work item
- Work dashboard (active work items with their threads)
- Thread-level agent profile selection (which agent runs this thread)
- Concurrent threads (writer can have multiple agents active)

### Out (post-v1)
- Thread branching (fork a thread into parallel paths)
- Subagent spawning (LLM-initiated thread creation)
- Compaction (summarizing long threads)
- Cross-work-item coordination
- Work item templates

## UI

### Work Dashboard
- Accessible from nav rail or command palette
- Lists active work items with status, thread count, last activity
- Quick-create: "New work item" with name input

### Work Item Detail
- Shows all threads in this work item
- Shows shared artifacts
- Thread list with agent profile, status (active/streaming/idle), last message preview
- Create new thread (pick agent profile + model)

### Thread Navigation
- Switching between threads within a work item is fast (LRU cached)
- Active/streaming threads show indicators
- Thread panel shows the work item context (which work item this thread belongs to)

## Why This Is v1

This is the core differentiator — "multiple agents working on your story simultaneously in a shared context." No other writing tool does this. It's also the foundation for CLI ↔ Flow convergence: same work model, same terminology, two interfaces.

Without work items, threads are just isolated chat sessions. With work items, they become coordinated work — which is the whole point of "agentic writing."
