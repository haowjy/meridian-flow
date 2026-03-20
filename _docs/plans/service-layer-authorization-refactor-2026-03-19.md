---
detail: minimal
audience: developer
---

# Service-Layer Authorization Refactor

## Goal

Move ownership checks from HTTP handlers into services so service APIs require `userID` and enforce authorization internally.

## Scope

- `backend/internal/handler/thread.go` -> `backend/internal/service/llm/streaming/service.go`
- `backend/internal/handler/collab_restore.go` -> `backend/internal/service/collab/restore_service.go`
- `backend/internal/handler/import.go` -> `backend/internal/service/docsystem/import.go`
- `backend/CLAUDE.md`

## Steps

1. Update service interfaces and concrete implementations to accept `userID` and call `authorizer.CanAccess*`.
2. Remove duplicated handler-layer auth checks and constructor dependencies that become unnecessary.
3. Update tests and wiring for the new service contracts.
4. Run `gofmt`, `go build`, targeted `go test`, and handler grep verification.
