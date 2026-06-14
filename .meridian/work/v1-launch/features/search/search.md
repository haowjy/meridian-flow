# Search

Cross-document and within-project search.

## Scope

- Full-text search across all project documents
- Search results with file path, line number, content preview
- Click result to open document at match location
- Search within current document (Cmd+F, CM6 built-in)
- Search from command palette (Cmd+K → type query)

## Implementation

- Backend: existing search API (`GET /api/documents/search`) — see `handler/document.go:SearchDocuments`
- Frontend: search results panel or inline in command palette
- Debounced query as user types
- Highlight matches in results

## Future (post-v1)

- Regex search
- Search and replace across documents
- Semantic search (AI-powered)

## Dependencies

- Command palette (search entry point)
- Editor (navigate to match location)
