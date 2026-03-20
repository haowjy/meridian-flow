# Agent Tools: Document-Native + just-bash

## Overview

Flow agents get two tiers of tool execution:

1. **Document-native tools** — direct API calls to the document tree (fast, no sidecar needed)
2. **just-bash sidecar** — lightweight in-memory bash interpreter for skills that need shell operations

Both run backend-side so execution survives tab close and supports session resume.

## Tier 1: Document-Native Tools

### Write routing by target path

All mutation tools (`Write`, `Edit`) work on all writable surfaces. The backend routes based on where the file lives:

| Target path | Write mechanism | Why |
|-------------|----------------|-----|
| Live docs (chapters, story content) | Routed through Yjs collab pipeline | User and agents may both be editing — needs CRDT ordering |
| `.meridian/work/` artifacts | Direct API write | Agent-owned workspace, no CRDT needed |
| `.agents/` | **Review-gated (autoapply=false)** | Agent profile namespace — changes require user review before taking effect |

### Context variables

Since we own the agent runtime, we inject the same environment variables as the CLI. The agent writes to `$MERIDIAN_WORK_DIR/notes.md` — the runtime resolves it. No path parsing or shim logic needed.

| Variable | Resolves to | Notes |
|----------|-------------|-------|
| `$MERIDIAN_WORK_DIR` | `.meridian/work/<work-item>/` | Scoped to the thread's work item |
| `$MERIDIAN_FS_DIR` | `.meridian/fs/` | Long-lived project reference material |
| `$MERIDIAN_CHAT_ID` | Current thread/session ID | For context passing between threads |

Same interface as CLI. One vocabulary, zero translation.

| Tool | Purpose | Notes |
|------|---------|-------|
| `Read` | Read document by path | Works on any document |
| `Write` | Create or replace document content | Backend routes through Yjs or direct based on target path |
| `Edit` | String replacement (old_string → new_string) | Same routing as Write |
| `Grep` | Search across project documents | Search API |
| `Glob` | List documents by pattern | Tree API + filter |

### Permission boundaries

| Path | Agent can read? | Agent can write? | Why |
|------|----------------|-----------------|-----|
| Project documents | Yes | Yes (via `Edit` / Yjs) | Collaborative editing through CRDT |
| `.meridian/work/<work-item>/` | Yes | Yes (via `Write` / direct) | Work item artifacts, agent-owned |
| `.agents/` | Yes | **Yes (review-gated)** | Agents can write to `.agents/` but changes are review-gated (autoapply=false on the system folder). Changes do not take effect until the user reviews and approves them. |

Write access to `.agents/` is review-gated rather than blocked outright: agents can propose profile or skill changes, but those proposals sit in a review queue until the user approves them. This preserves the human-in-the-loop on any modification to agent capabilities.

No sidecar, no bash, no filesystem. Just API calls with path-based authorization. This covers the majority of agent interactions.

## Tier 2: just-bash Sidecar

For skills with `scripts/` or instructions that reference shell commands, a TS sidecar running Vercel Labs' `just-bash` provides an in-memory bash interpreter.

### Architecture

```
Go Backend                    TS Sidecar (just-bash)
┌──────────────┐              ┌──────────────────┐
│ Agent request │──internal──→│ Receive command   │
│ "bash" tool   │   API       │ Execute in        │
│              │              │ just-bash runtime  │
│              │←─────────────│ Return stdout/err  │
└──────────────┘              └──────────────────┘
       │                              │
       │                    ┌─────────┴─────────┐
       │                    │ Virtual FS mount   │
       │                    │ (doc tree as files) │
       │                    └───────────────────┘
```

### Virtual FS Mount

The document tree is projected as files in the bash context:

- `cat chapter-12.md` → reads document content via API
- `echo "new content" > notes.md` → creates/updates document via API
- `grep "character" *.md` → searches across documents
- `ls` → lists documents in current folder

The FS is a thin translation layer — reads/writes go through the document API, not a real filesystem.

### Why Backend-Side

- **Durable** — execution survives tab close, browser crash, network drop
- **Resumable** — user can come back and see results
- **Billable** — credit deduction happens server-side where it's authoritative
- **Secure** — no client-side code execution

### Limitations (v1)

- No package installs (no apt, npm, pip)
- No network access from bash context
- No long-running background processes
- No binary execution — text operations only
- Limited to what `just-bash` supports (subset of bash)

### Post-v1: Full Sandbox Upgrade

When skills need real package installs, network access, or complex multi-process pipelines:
- Daytona (Go SDK, managed platform, ~$0.07/hr)
- E2B (Firecracker microVMs, strong isolation)
- On-demand per active thread, not always-on per work item
- Doc tree synced in/out of sandbox
- Supabase stays source of truth

## Tool Selection at Runtime

The agent's tool set is determined by:

1. **Agent profile** — which tools are enabled in the `.agents/agents/<name>.md` frontmatter
2. **Skill context** — skills can declare required tools
3. **Runtime availability** — if just-bash sidecar is running, bash tool is available; otherwise only document-native tools

Most writing-focused agents only need Tier 1 (document-native). Tier 2 (bash) is for power-user skills and automation.
