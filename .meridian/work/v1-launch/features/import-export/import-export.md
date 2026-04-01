# Import / Export

Project and document import/export for portability.

## Scope

### Export
- **Zip archive** — full project export (documents, folder structure, `.agents/` config)
- **Single document** — markdown download

> **Post-v1:** EPUB export (table of contents, chapter breaks, metadata; for distribution to readers) is deferred.

### Import
- **Zip archive** — restore full project from export
- **Git import for agents/skills** — clone `.agents/` from a git repo into project. See [agent-import.md](../agents/agent-import.md)
- **Markdown files** — drag-and-drop or upload
- **Bulk import** — folder of markdown files preserving structure

## Carry Forward

- Existing backend zip import/export (`service/docsystem/zip_file_processor.go`)
- Existing archive utilities (`internal/utils/archive.go`)

## Future (post-v1)

- Google Docs import
- Scrivener import (.scriv)
- Royal Road import (chapter scraping)
- Auto-story-bible generation on import (the "Meridian Moment")

## Dependencies

- Explorer (imported files appear in tree)
- Agents + Skills (git import flow)
