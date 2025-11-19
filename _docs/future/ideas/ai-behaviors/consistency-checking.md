---
status: future
priority: high
featureset: ai-behaviors
---

# Consistency Checking

## Overview

AI actively monitors for contradictions across documents and prompts the user to resolve them.

**When**: While writing (real-time) or after saving (batch analysis).

## User Experience

```
While writing:
"I noticed you mentioned Elara's eyes as green here,
 but Characters/Elara says blue. Which is correct?

 [Update character doc] [Update this chapter] [Ignore]"
```

**Key principles:**
- Non-intrusive (doesn't block writing)
- Actionable (provides clear resolution options)
- Dismissible (user can ignore if intentional)

## Implementation Approach

### Real-Time Checking (Phase 1)

```mermaid
sequenceDiagram
    participant User
    participant Editor
    participant AI
    participant VectorDB as Vector Search

    User->>Editor: Types "green eyes"
    Editor->>Editor: Debounce (2s idle)
    Editor->>VectorDB: Search for "Elara eyes green"
    VectorDB-->>Editor: Character/Elara.md (eyes: blue)
    Editor->>AI: Check contradiction
    AI-->>Editor: Contradiction detected
    Editor->>User: Show inline warning ⚠️

    style AI fill:#2d7d2d
    style VectorDB fill:#7d4d4d
```

**Components:**
1. **Named Entity Recognition** - Extract character/location mentions
2. **Vector Search** - Find related documents (character sheets, location docs)
3. **Contradiction Detection** - Compare attributes (LLM-based)
4. **Inline Warnings** - TipTap decorations with action buttons

### Batch Analysis (Phase 2)

```
After saving:
"Consistency check found 3 potential issues:

1. Character: Elara's eye color
   - Chapter 5: 'green eyes'
   - Character doc: 'blue eyes'
   [Review]

2. Location: The Capital's population
   - Chapter 12: '500,000 people'
   - Location doc: '50,000 people'
   [Review]

3. Event: Timeline mismatch
   - Chapter 8: 'three days later'
   - Previous chapter: 'a week passed'
   [Review]"
```

## Technical Requirements

### Vector Search Prerequisite

Requires semantic search to find relevant documents efficiently.

**See:** [`../search/vector-search.md`](../search/vector-search.md)

### LLM Prompt Pattern

```
System: You are a consistency checker for a fiction project.

User: Compare these two excerpts and identify contradictions:

Document 1 (Characters/Elara.md):
"Elara has striking blue eyes and long black hair."

Document 2 (Chapter 5):
"Her green eyes sparkled in the moonlight."

Identify any contradictions.
```

**Expected response:**
```json
{
  "has_contradiction": true,
  "type": "attribute_mismatch",
  "entity": "Elara",
  "attribute": "eye_color",
  "values": {
    "character_doc": "blue",
    "chapter": "green"
  },
  "confidence": 0.95
}
```

### Performance Considerations

- **Debounce**: 2s idle time before checking (avoid interrupting flow)
- **Cache**: Store recent entity attributes in memory
- **Batch**: Queue checks and process in background
- **Limit**: Only check entities with existing documents

## Related Features

- [Proactive Assistance](./proactive-assistance.md) - Overview of agentic behaviors
- [Vector Search](../search/vector-search.md) - Required for document lookup
- [Auto-Context](../../post-mvp/ai-suggestions.md) - Related to context management

## References

- Source: `_docs/high-level/3-vision.md` (original vision)
- Named Entity Recognition: https://spacy.io/usage/linguistic-features#named-entities
