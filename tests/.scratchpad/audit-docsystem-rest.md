# Audit: Docsystem & REST Handlers (gpt-5.4, p25)

## Path Validation

- **HIGH** `path_resolver.go:31,79` — Folder-path based creates/imports bypass the shared path validator. `document.go:85` routes `folder_path` through the resolver, but malformed paths (empty segments, `..`) can slip through. Reserved root namespaces can be created without folder-service guards.

## ZIP Import

- **HIGH** `zip_file_processor.go:112,243` — ZIP imports ignore the request `folder_path`. Individual-file import honors it; ZIP import rebuilds destinations only from archive paths.

## Soft Delete Propagation

- **HIGH** `project.go:181`, `docsystem/project.go:279` — Project soft delete doesn't propagate to child queries. Document/folder reads (`.go:454`, `.go:515`, `folder.go:467`) only filter child `deleted_at`. Deleted project contents remain queryable at the repository layer.

## Transaction Gaps

- **MEDIUM** `folder.go:310` — Recursive folder delete performs many child deletes without a transaction. Replace import (`import.go:127`) deletes everything before re-importing. Failure in the middle leaves partial state.

## Error Mapping

- **MEDIUM** `identifier/resolver.go:96`, `handler/document.go:77` — Standalone document endpoints return 500 for path-like identifiers instead of 400. `resolver` returns `ValidationError` but handler branches on `ErrBadRequest`.

## Transaction Conflict Recovery

- **MEDIUM** `postgres/transaction.go:24` — Duplicate-conflict recovery is unreliable inside transactions. After unique-violation, repository conflict handlers issue follow-up lookups on the same (already-aborted) tx. Folder `CreateIfNotExists` can fail to recover from races.

## Import Error Handling

- **MEDIUM** `import.go:145,163` — Import handler returns raw 500s instead of routing through `handleError()`. Structured domain/validation errors are flattened.

## Validation.By() Pointer Bug

No additional `validation.By()` pointer bugs found beyond the project.go `*string` one already fixed. Remaining pointer-based ozzo validation uses built-in rules.
