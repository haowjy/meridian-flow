# @mentions

CM6 autocomplete shared across editor and chat input. Same data model, different rendering per surface.

## Scope

- `@` trigger opens autocomplete dropdown
- Search across: documents, chapters, characters, locations (project entities)
- Autocomplete with fuzzy matching
- Insert on select

### Dual Rendering

| Surface | Rendered as | Interaction |
|---------|------------|-------------|
| Editor | Wiki link (`[[Document Name]]`) | Click navigates to document |
| Chat input | @mention chip (inline badge) | Visual indicator, included in prompt context |

Same underlying data model — a mention entity with a stable ID pointing to a project resource.

## Prerequisite: Canonical Mention Entity

Before implementation, define:
- Mention entity schema: `{ id, type, name, target_id }`
- Stable IDs that survive renames (mention points to document ID, not name)
- Serialization format per surface (wiki link syntax vs chip markup)
- Copy/paste behavior (mention in editor → paste in chat should preserve)
- Rename handling (document renamed → mention display updates, ID stable)

Without this, rename collisions, duplicate titles, and cross-surface copy/paste will break.

## Carry Forward

- Existing @mention patterns in current frontend (if any)
- CM6 autocomplete extension infrastructure

## Dependencies

- CM6 shared extensions (autocomplete plugin)
- Explorer (document list for autocomplete)
- Editor + Threads (both consume mentions)
