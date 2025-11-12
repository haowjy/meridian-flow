---
detail: minimal
audience: developer
---

# Workspace + Submodule (meridian-stream-go)

## Problem
Edit `meridian-stream-go` and backend together locally, while CI/production stay pinned to a version from GitHub.

## Solution
Use a Go workspace to prefer local sources during development, and keep `backend/go.mod` pinned to a tag/commit of `github.com/haowjy/meridian-stream-go` for builds.

## Implementation
- Workspace file: `go.work:1` (root)
- Modules included: `./backend`, `./meridian-stream-go`, `./meridian-llm-go`
- Canonical import path (do not change): `github.com/haowjy/meridian-stream-go` (see `meridian-stream-go/go.mod:1`)
- Submodule registration: `.gitmodules:1`

## Commands
- Init workspace (done): `go work init ./backend ./meridian-stream-go`
- Check active workspace: `go env GOWORK`
- Temporarily disable: `GOWORK=off go test ./...` (from `backend`)
- Pin for CI: `cd backend && go get github.com/haowjy/meridian-stream-go@v0.0.1 && go mod tidy`

## Makefile shortcuts
- `make -C backend build-local` — build with workspace explicitly (`GOWORK=../go.work`)
- `make -C backend run-local` — run with workspace explicitly
- Remote/pinned build: `GOWORK=off make -C backend build`
- Remote/pinned run: `GOWORK=off make -C backend run`

## Flow
1) Develop: edit code in `meridian-stream-go/` → build/test in `backend/` (workspace picks local copy).
2) Upstream: push changes to `github.com/haowjy/meridian-stream-go`.
3) Update backend: bump version in `backend/go.mod` to the new tag/commit and commit the change.

## Notes
- Prefer workspace over `replace` for local work. If you must use `replace`, keep it local and avoid committing path-based replaces.
- Decide whether to commit `go.work`. If committed, everyone (and CI) will build against the submodule; if not, add `go.work` to `.gitignore` for per-dev use.
