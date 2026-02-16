# Backend Rules (Go / SQL / API)

These rules apply when `backend/` files are in the diff.

## Dynamic Table Names

1. **Always use `db.Tables.*`**: Never hardcode table names in queries. Use `fmt.Sprintf` with `db.Tables.Documents`, etc.

## SQL Migrations

2. **`-- +goose ENVSUB ON`**: Required in both Up and Down sections of every migration file.
3. **`${TABLE_PREFIX}` on all app tables**: Tables, indexes (`idx_${TABLE_PREFIX}...`), and constraints must use the prefix.
4. **No hardcoded prefixes**: Never use `dev_`, `test_`, `prod_`, or unprefixed app table names.
5. **Read existing migrations first**: Before writing new migrations, inspect `00001_initial_schema.sql`, the most recent migration, and one similar migration.

## Error Handling

6. **Use `httputil.RespondError()`**: All HTTP error responses must go through `httputil.RespondError(w, status, message)`.
7. **RFC 7807 Problem Details**: All errors use this format with `type`, `title`, `status`, `detail` fields.
8. **409 Conflict uses `resource` field**: Use `RespondErrorWithExtras()` for conflicts. The extra field must be named `resource` (not `document`, `project`, etc.).

## Dependencies

9. **No `replace` directives in `go.mod`**: These break Docker builds. Use `go.work` for local submodule development.

## Streaming

10. **Atomic `PersistAndClear()` pattern**: Always use `stream.PersistAndClear(func(events) error { ... })`. Never separate persist and clear into two calls (race condition).

## Validation

11. **All names trimmed**: Project/folder/document names must be trimmed of leading/trailing whitespace.
12. **Names validated against max lengths**: Check that validation exists for name length limits.
13. **Folder/document names cannot contain `/`**: Validated with `^[^/]+$` regex.

## API Conventions

14. **List endpoints return `[]` not `null`**: Empty lists must be `[]`, never JSON `null`.
15. **Delete returns 204**: DELETE operations return `204 No Content` with no body.

## Architecture

16. **Clean Architecture layers**: Handler → Service → Repository. No skipping layers (handler must not call repository directly).
17. **Domain interfaces in `internal/domain/`**: Business interfaces live here, not in implementation packages.
18. **Depend on interfaces, not concrete types**: Especially for external services (LLM providers, search clients).

## Tool System

19. **New tools implement `ToolExecutor` interface**: Single method: `Execute(ctx, input) (result, error)`.
20. **Use `ToolRegistryBuilder`**: Register tools via builder's fluent `With*()` methods, not direct registry manipulation.

## Configuration

21. **No magic numbers**: Use `ToolConfig` or similar centralized config for limits, timeouts, thresholds.
22. **Environment variables documented**: New env vars must be added to `.env.example`.
