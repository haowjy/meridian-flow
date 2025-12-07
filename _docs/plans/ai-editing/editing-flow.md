# AI Editing Flows

Visual reference for all AI editing scenarios.

---

## Data Model

### Storage

| What | Where | Format |
|------|-------|--------|
| User content | `documents.content` | Pure markdown (auto-saved) |
| AI version | `ai_sessions.ai_version` | Pre-computed document with all AI edits |
| Edit history | `ai_edits` table | Operations (old_str, new_str) for audit |

### Key Insight

```
documents.content = USER_EDITS (always, auto-saved)
ai_sessions.ai_version = Pre-computed document with all AI edits
Frontend computes diff(USER_EDITS, ai_version) live for display
```

### Status Values

**Session**: `active` | `accepted` | `rejected`
**Edit**: `pending` | `accepted` | `rejected`

---

## Flow 1: AI Makes Suggestion

```mermaid
sequenceDiagram
    participant User
    participant Chat
    participant LLM
    participant Backend
    participant Editor

    User->>Chat: "Make chapter 5 more suspenseful"
    Chat->>LLM: Request with doc context
    LLM->>Backend: doc_edit(str_replace, "/Chapter 5.md", old, new)
    Backend->>Backend: Get/create ai_session
    Backend->>Backend: Store ai_edit + update ai_version
    Backend-->>LLM: {success, edit_id, session_id}
    LLM-->>Chat: "I've suggested some changes"

    Note over Chat: SuggestionCard appears

    User->>Editor: Opens Chapter 5
    Editor->>Backend: GET /documents/:id
    Editor->>Backend: GET /documents/:id/ai-session
    Backend-->>Editor: {markdown, session with ai_version}
    Editor->>Editor: Compute diff(USER_EDITS, ai_version)

    Note over Editor: Shows inline diff: ~~old~~ new
```

---

## Flow 2: Keep All (Accept)

Replaces user content with ai_version, resolves session.

```mermaid
sequenceDiagram
    participant User
    participant Editor
    participant Backend

    User->>Editor: Click "Keep All"

    Editor->>Editor: Replace doc content with ai_version
    Editor->>Backend: PATCH /documents/:id {content: ai_version}
    Backend-->>Editor: {updated document}

    Editor->>Backend: POST /ai-sessions/:id/resolve {status: accepted}
    Backend->>Backend: Set status='accepted'
    Backend-->>Editor: 204 OK

    Note over Editor: AI version is now the document
```

---

## Flow 3: Undo All (Reject)

Keeps user content unchanged, resolves session.

```mermaid
sequenceDiagram
    participant User
    participant Editor
    participant Backend

    User->>Editor: Click "Undo All"

    Note over Editor: No document change needed -<br/>USER_EDITS already preserved

    Editor->>Backend: POST /ai-sessions/:id/resolve {status: rejected}
    Backend->>Backend: Set status='rejected'
    Backend-->>Editor: 204 OK

    Note over Editor: Diff clears, user keeps their version
```

---

## Flow 4: Live Diff Display

Frontend computes diff on-the-fly. No position tracking or conflict detection needed.

```mermaid
sequenceDiagram
    participant Editor
    participant Backend

    Editor->>Backend: GET /documents/:id/ai-session
    Backend-->>Editor: {ai_version, status: active}

    Editor->>Editor: Compute diff(USER_EDITS, ai_version)
    Editor->>Editor: Display inline: ~~old~~ new

    Note over Editor: User edits freely, diff recomputes live
```

### Key Behavior

1. **Always live**: Diff computed from `USER_EDITS` (editor state) vs `ai_version` (from session)
2. **No string matching**: No need to find `old_str` - diff handles everything
3. **No conflicts**: User's changes and AI changes shown side-by-side as diff hunks
4. **Recomputes on edit**: User types → diff updates instantly

### Why This Works

- `ai_version` is pre-computed by backend (base + all AI edits)
- Frontend only needs two strings to diff
- No position hints, mark matching, or fallback logic

---

## Flow 5: LLM Views Document

When LLM calls `view`, it sees USER_EDITS + all AI edits applied.

```mermaid
sequenceDiagram
    participant LLM
    participant Backend

    LLM->>Backend: doc_edit(view, "/Chapter 5.md")

    alt No active session
        Backend->>Backend: Get documents.content
        Backend-->>LLM: {content: USER_EDITS}
    else Active session exists
        Backend->>Backend: Get ai_version from session
        Backend-->>LLM: {content: ai_version}
        Note over Backend: ai_version = base + all AI edits
    end
```

---

## Flow 6: Auto-Save Behavior

Auto-save always saves USER_EDITS (unchanged during AI session).

```mermaid
sequenceDiagram
    participant User
    participant Editor
    participant AutoSave
    participant Backend

    User->>Editor: Types content

    Editor->>Editor: Update USER_EDITS
    Editor->>Editor: 1s debounce...

    AutoSave->>Backend: PATCH /documents/:id {content: USER_EDITS}
    Backend-->>AutoSave: {updated document}

    Note over Backend: documents.content = USER_EDITS<br/>ai_version stays unchanged<br/>Diff recomputes on next render
```

---

## Summary: What Gets Stored Where

```
+-------------------------------------------------------------+
|                    Frontend (CodeMirror)                    |
|  +-----------------------------------------------------+   |
|  |  USER_EDITS + live diff display                     |   |
|  |  diff(USER_EDITS, ai_version) computed on-the-fly   |   |
|  +-----------------------------------------------------+   |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|                      Backend (DB)                           |
|  +------------------+  +---------------------------------+ |
|  | documents.content|  | ai_sessions                     | |
|  | = USER_EDITS     |  |  - base_snapshot                | |
|  | (pure markdown)  |  |  - ai_version (precomputed)     | |
|  +------------------+  |  - status: active/accepted/rej  | |
|                        +---------------------------------+ |
|                        | ai_edits (history/audit only)   | |
|                        |  - old_str, new_str             | |
|                        |  - status: pending/accepted/rej | |
|                        +---------------------------------+ |
+-------------------------------------------------------------+
```
