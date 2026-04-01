# Routes

No routing yet. Frontend-v2 is in Phase 2 (atoms). Routing is Phase 8.

## Planned Route Structure

```
/projects/{id}/studio/...     → StudioLayout (editor-primary)
/projects/{id}/converse/...   → ConverseLayout (chat-primary)
/projects/{id}/agents/...     → AgentsLayout (orchestration)
```

Mode switching via Rail icons changes URL and toggles CSS visibility on layouts (no unmount/remount).
