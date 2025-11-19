---
status: future
priority: medium
featureset: ai-behaviors
---

# Proactive AI Assistance

## Overview

AI doesn't just respond when asked - it proactively helps writers by detecting issues, suggesting improvements, and offering relevant context.

**Note:** These are hypothetical behaviors. User feedback will determine what's actually valuable.

## Potential Behaviors

### Consistency Checking (While Writing)

AI notices contradictions across documents and prompts the user:

```
While writing:
"I noticed you mentioned Elara's eyes as green here,
 but Characters/Elara says blue. Which is correct?

 [Update character doc] [Update this chapter] [Ignore]"
```

**Implementation:**
- Monitor document edits in real-time
- Check new content against character/location documents
- Use vector search to find related documents
- Highlight contradictions with actionable fixes

### Missing Document Detection (After Saving)

AI identifies entities mentioned but not documented:

```
After saving:
"This chapter mentions several entities I couldn't
 find documents for:
 - Master Chen (no character document)
 - Council of Seven (no faction document)

 Want me to create placeholder documents?"
```

**Implementation:**
- Named entity recognition on saved content
- Search document tree for matching names
- Offer to create stubs in appropriate folders

### Context Loading Suggestions (Proactive Analysis)

AI suggests loading relevant documents based on writing patterns:

```
Proactive analysis:
"You haven't referenced Locations/The Capital in
 20 chapters but you're writing about it now.
 Want me to load it into context?"
```

**Implementation:**
- Track document access patterns
- Detect mentions of entities/locations
- Compare current context to relevant documents
- Suggest loading documents that haven't been referenced recently

## Related Features

- [Consistency Checking](./consistency-checking.md) - Detailed implementation plan
- Auto-context detection: `../document-integration/auto-context.md`
- AI suggestions system: `../../post-mvp/ai-suggestions.md`

## References

- Source: `_docs/high-level/3-vision.md` (original vision document)
