# Docsystem Domain

Types and interfaces for the document management system (projects, folders, documents). Import: `meridian/internal/domain/docsystem`. Deep dive: `.meridian/fs/backend/tools/` (text editor, namespace isolation).

## Key Concepts

- **ISP DocumentStore**: Split into `DocumentReader` (5 methods), `DocumentWriter` (4 methods), `DocumentSearcher` (1 method), `DocumentPathResolver` (1 method). Composite `DocumentStore` embeds all four. Depend on the narrowest interface your code needs.
- **File types**: `FileType` enum in `file_type.go` -- documents have types (chapter, note, etc.) that affect UI and behavior.
- **Path resolution**: Documents have computed paths from folder hierarchy. `DocumentPathResolver.GetPath` resolves document ID to full path.
- **Content storage**: Markdown (TEXT column). Single source of truth for content, word count, and search. Frontend handles markdown <-> editor conversion.
- **Namespace service**: Projects have slug-based namespaces for URL routing.

## Interfaces

| Interface | Purpose | File |
|-----------|---------|------|
| `DocumentReader` | GetByID, GetByPath, ListByFolder, GetAllMetadata | `document_reader.go` |
| `DocumentWriter` | Create, Update, Delete, DeleteAllByProject | `document_writer.go` |
| `DocumentSearcher` | SearchDocuments | `document_searcher.go` |
| `DocumentPathResolver` | GetPath | `path_resolver.go` |
| `PathNotationResolver` | Unix-style path notation resolution + folder creation | `path_resolver.go` |
| `DocumentStore` | Composite (Reader+Writer+Searcher+PathResolver) | `document_store.go` |
| `FolderStore` | Folder CRUD | `folder_store.go` |
| `ProjectStore` | Project CRUD | `project_store.go` |
| `FavoriteStore` | User-project favorites | `favorite_store.go` |
| `DocumentService` | Document business logic | `document_service.go` |
| `FolderService` | Folder business logic | `folder_service.go` |
| `ProjectService` | Project business logic | `project_service.go` |
| `FavoriteService` | Favorite business logic | `favorite_service.go` |
| `TreeService` | Hierarchical tree view | `tree_service.go` |
| `ImportService` | File import (docx, etc.) | `import_service.go` |
| `NamespaceService` | Slug-based namespace routing | `namespace_service.go` |
| `ContentAnalyzer` | Content analysis (word count) | `content_analyzer.go` |
| `ContentConverter` | Format conversion | `content_converter.go` |
| `FileProcessor` | Import file processing | `file_processor.go` |

## Conventions

- `GetByID` requires `projectID` for ownership verification. `GetByIDOnly` skips it (internal use).
- `DeleteAllByProject` has `skipSystemFolders` flag to preserve root/trash folders.
- Import sanitizes `/` to `-` in document names (filesystem semantics).
