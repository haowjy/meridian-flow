package streaming

import (
	"context"
	"fmt"

	"meridian/internal/domain"
	domainwi "meridian/internal/domain/workitem"
)

// ResolvedContext holds the resolved work session paths for a thread.
// All path fields use the canonical .meridian/ prefix so callers can pass them
// directly to file-system and document-system operations.
type ResolvedContext struct {
	WorkDir  string // .meridian/work/<slug>/
	FSDir    string // .meridian/fs
	ThreadID string
	WorkItem string // slug
}

// contextResolver resolves work context variables (WorkDir, FSDir, ThreadID, WorkItem slug)
// for a thread. The caller must ensure the thread has an associated work item via
// EnsureThreadWorkItem before calling ResolveWorkContext.
type contextResolver struct {
	workItemStore domainwi.Store
}

// NewContextResolver creates a new contextResolver.
func NewContextResolver(workItemStore domainwi.Store) *contextResolver {
	return &contextResolver{workItemStore: workItemStore}
}

// ResolveWorkContext resolves the work context variables for a thread.
//
// If workItemID is nil or empty it returns an error — callers must attach a work
// item first (e.g. via EnsureThreadWorkItem) before calling this method.
// FSDir is always ".meridian/fs"; WorkDir is ".meridian/work/<slug>/".
func (r *contextResolver) ResolveWorkContext(ctx context.Context, threadID string, workItemID *string) (*ResolvedContext, error) {
	// Guard: caller must ensure a work item is attached before resolving context.
	// An absent workItemID indicates the caller skipped EnsureThreadWorkItem.
	if workItemID == nil || *workItemID == "" {
		return nil, domain.NewValidationError("thread has no associated work item; call EnsureThreadWorkItem first")
	}

	// Look up the work item by ID to get its slug.
	item, err := r.workItemStore.GetByID(ctx, *workItemID)
	if err != nil {
		return nil, fmt.Errorf("resolve work context: look up work item %s: %w", *workItemID, err)
	}

	return &ResolvedContext{
		WorkDir:  fmt.Sprintf(".meridian/work/%s/", item.Slug),
		FSDir:    ".meridian/fs",
		ThreadID: threadID,
		WorkItem: item.Slug,
	}, nil
}
