# Phase 3: Auth Consolidation

## Scope

Extract a reusable, transport-agnostic auth primitive from the duplicated WS auth code (R1 + R3). Currently auth logic is scattered:

- `collab_authenticator.go:56-117` — `bootstrapAuth()` reads JWT from `x/net/websocket`, verifies it, checks identity blocking, parses UUIDs
- `collab_document_handler.go:149-211` — Reimplements the same JWT/ownership flow inline against `coder/websocket`
- `collab_project.go:72-87` — Inline error-code mapping (`ErrAuthFailed` → `AUTH_FAILED`, etc.)

After this phase, a single `authenticateToken(token string)` function handles JWT verification, identity blocking, UUID parsing, and expiry capture — independent of WS library. Both existing paths call it. The wsutil framework (Phase 5) will also call it.

## What's Out of Scope

- wsutil auth.go implementation (Phase 5)
- Any changes to streaming service layer
- Document Yjs WS auth changes (that handler stays as-is)

## Prerequisites

None — this is a Round 1 phase. No file overlap with Phases 1, 4, or 5.

## Files to Modify

| File | Change |
|------|--------|
| `backend/internal/handler/collab_authenticator.go:56-117` | Extract core auth logic into `authenticateToken(token string) (*collabAuthResult, error)`. This does JWT verification, identity blocking, UUID parsing, expiry capture — everything except reading from the wire. |
| `backend/internal/handler/collab_authenticator.go:122-148` | `bootstrapProjectAuth()` becomes: read token from `x/net/websocket` → call `authenticateToken()` → project access check |
| `backend/internal/handler/collab_document_handler.go:149-211` | Replace inline auth with: read token from `coder/websocket` → call `authenticateToken()` → document-specific checks |
| `backend/internal/handler/collab_authenticator.go` (new func) | Add `authErrorToCodeAndMessage(err error) (code string, message string)` — pure function mapping domain errors to wire codes |
| `backend/internal/handler/collab_project.go:72-87` | Replace inline error switch with `authErrorToCodeAndMessage()` call |

## Interface Contract

```go
// authenticateToken verifies a JWT and returns auth context.
// Transport-agnostic: takes the raw token string, not a WS connection.
// Used by: x/net/websocket collab, coder/websocket document, and wsutil framework.
func authenticateToken(token string, verifier JWTVerifier, identityChecker IdentityBlockChecker) (*collabAuthResult, error)

// authErrorToCodeAndMessage maps domain auth errors to wire-protocol error codes.
// Returns (code, message) suitable for sending to the client.
func authErrorToCodeAndMessage(err error) (code string, message string)
```

## Patterns to Follow

- Existing `collabAuthResult` struct in `collab_authenticator.go`
- Error types: `ErrAuthFailed`, `ErrAuthExpired`, `ErrForbidden` in the collab auth module

## Verification Criteria

- [ ] `go build ./backend/...` passes
- [ ] `go test ./backend/internal/handler/...` passes — existing collab tests verify auth still works
- [ ] Project WS auth flow: connect → JWT auth → project access check → `project:connected` response (unchanged behavior)
- [ ] Document WS auth flow: connect → JWT auth → document ownership check (unchanged behavior)
- [ ] `go vet ./backend/...` passes
- [ ] No duplicated JWT verification logic remains (grep for `verifyJWT` or equivalent shows single implementation)

## Agent Staffing

- **Implementer**: `coder` (default codex — mechanical extraction)
- **Reviewers**: 1x security review (gpt-5.4 — focus: auth extraction preserves all security checks, no bypass paths introduced)
- **Verification**: `verifier`
