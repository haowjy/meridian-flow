# Phase A5a: Context Variable Resolver

## Scope
Create contextResolver that resolves work context variables (WorkDir, FSDir, ThreadID, WorkItem slug) for a thread.

## Files to Create
- `backend/internal/service/llm/streaming/context_resolver.go`
- `backend/internal/service/llm/streaming/context_resolver_test.go`

## Key Details
```go
type contextResolver struct {
    workItemStore domainwi.Store
}

type ResolvedContext struct {
    WorkDir  string // .meridian/work/<slug>/
    FSDir    string // .meridian/fs
    ThreadID string
    WorkItem string // slug
}

func (r *contextResolver) ResolveWorkContext(ctx context.Context, threadID string, workItemID *string) (*ResolvedContext, error)
```

- If workItemID is nil/empty → return error (caller must ensure work item via EnsureThreadWorkItem)
- FSDir is always `.meridian/fs`
- WorkDir is `.meridian/work/<slug>/`
- Look up work item by ID to get slug

## Verification Criteria
- [ ] `make test` passes
- [ ] Thread with work item → correct paths
- [ ] Thread without work item → error
- [ ] FSDir always `.meridian/fs`
- [ ] WorkDir is `.meridian/work/<slug>/`
- [ ] `go vet ./...` clean
