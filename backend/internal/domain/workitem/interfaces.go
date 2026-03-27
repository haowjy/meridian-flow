package workitem

import (
	"context"
	"time"
)

// Store defines the persistence contract for work items.
// Auth checks and business rules live in the Service layer.
// All methods scope to the caller's project implicitly via WorkItem.ProjectID
// or explicit parameters where cross-table joins are needed.
type Store interface {
	// GetMostRecentActiveEphemeral returns the most recently created non-deleted,
	// active, ephemeral work item for the project. Used by EnsureThreadWorkItem
	// when the per-project ephemeral cap (100) has been reached.
	// Returns domain.ErrNotFound if no matching work item exists.
	GetMostRecentActiveEphemeral(ctx context.Context, projectID string) (*WorkItem, error)

	// Create inserts a new work item row. The caller is responsible for
	// generating a valid slug before calling Create.
	Create(ctx context.Context, item *WorkItem) error

	// GetByID returns a non-deleted work item by UUID.
	// Returns domain.ErrNotFound if not found or soft-deleted.
	GetByID(ctx context.Context, id string) (*WorkItem, error)

	// GetBySlug returns a non-deleted work item by project + slug.
	// Returns domain.ErrNotFound if not found or soft-deleted.
	GetBySlug(ctx context.Context, projectID, slug string) (*WorkItem, error)

	// ListByProject returns a page of non-deleted work items for a project,
	// ordered by created_at DESC. Returns the items, total row count, and error.
	// If status is non-empty, only items with that status are returned.
	ListByProject(ctx context.Context, projectID, status string, offset, limit int) ([]WorkItem, int, error)

	// Update persists mutable fields (name, description, metadata).
	// Slug and status must be mutated through dedicated methods.
	Update(ctx context.Context, item *WorkItem) error

	// UpdateStatus atomically transitions status from `from` to `to`.
	// updated_at is managed by the DB trigger; callers do not supply it.
	// Returns domain.ErrNotFound if the row is missing or already deleted.
	// Returns domain.ErrConflict if the current status does not equal `from`.
	UpdateStatus(ctx context.Context, id string, from, to Status) error

	// SoftDelete sets deleted_at, removing the item from all default list queries.
	// Thread associations are preserved for future restore or audit.
	SoftDelete(ctx context.Context, id string, deletedAt time.Time) error

	// AttachThread sets threads.work_item_id for the given thread.
	// Both thread and work item must belong to the same project;
	// cross-project validation is enforced in the service layer.
	AttachThread(ctx context.Context, threadID, workItemID string) error

	// ListThreads returns a page of non-deleted threads attached to a work item,
	// ordered by updated_at DESC. Returns items, total count, and error.
	ListThreads(ctx context.Context, workItemID string, offset, limit int) ([]ThreadSummary, int, error)

	// HasStreamingThreads reports whether any turn currently in 'streaming'
	// status belongs to a thread attached to the given work item.
	// Used by Complete to guard against completing mid-stream items.
	HasStreamingThreads(ctx context.Context, workItemID string) (bool, error)

	// CountAttachedThreads returns the count of non-deleted threads whose
	// work_item_id equals workItemID.
	CountAttachedThreads(ctx context.Context, workItemID string) (int, error)

	// CountActiveEphemerals returns the number of non-deleted, active,
	// ephemeral work items for the project. Used for ephemeral-cap enforcement
	// (max 100 per project).
	CountActiveEphemerals(ctx context.Context, projectID string) (int, error)
}

// Service defines the application-logic contract for work items.
// All Service methods perform auth checks and enforce business rules before
// delegating to the Store.
type Service interface {
	// Create validates the request, generates the slug, and persists the work item.
	Create(ctx context.Context, projectID, userID string, req *CreateRequest) (*WorkItem, error)

	// Get returns the work item by UUID (no user scoping — caller must check access).
	Get(ctx context.Context, id string) (*WorkItem, error)

	// GetBySlug returns the work item by project + slug.
	// userID is used to verify the caller has project membership.
	GetBySlug(ctx context.Context, projectID, userID, slug string) (*WorkItem, error)

	// List returns a page of non-deleted work items for a project.
	// userID is used to verify the caller has project membership.
	// If status is non-empty, only items with that status are returned.
	List(ctx context.Context, projectID, userID, status string, offset, limit int) ([]WorkItem, int, error)

	// Update applies a partial patch (name, description, metadata).
	// userID is used to verify the caller has membership in the item's project.
	Update(ctx context.Context, id, userID string, req *UpdateRequest) (*WorkItem, error)

	// UpdateBySlug applies a partial patch (name, description, metadata) to a
	// work item resolved by project + slug.
	// userID is used to verify the caller has project membership.
	UpdateBySlug(ctx context.Context, projectID, userID, slug string, req *UpdateRequest) (*WorkItem, error)

	// Complete transitions a work item from active to done.
	// Rejects if any associated thread has an in-flight streaming turn.
	// userID is used to verify the caller has membership in the item's project.
	Complete(ctx context.Context, id, userID string) (*WorkItem, error)

	// CompleteBySlug transitions a work item from active to done by project + slug.
	// userID is used to verify the caller has project membership.
	CompleteBySlug(ctx context.Context, projectID, userID, slug string) (*WorkItem, error)

	// Reopen transitions a work item from done back to active.
	// userID is used to verify the caller has membership in the item's project.
	Reopen(ctx context.Context, id, userID string) (*WorkItem, error)

	// ReopenBySlug transitions a work item from done back to active by project + slug.
	// userID is used to verify the caller has project membership.
	ReopenBySlug(ctx context.Context, projectID, userID, slug string) (*WorkItem, error)

	// Delete soft-deletes the work item.
	// Thread associations are preserved; artifact folder deletion is handled
	// by callers that own the docsystem.
	// userID is used to verify the caller has membership in the item's project.
	Delete(ctx context.Context, id, userID string) (*WorkItem, error)

	// DeleteBySlug soft-deletes the work item resolved by project + slug.
	// userID is used to verify the caller has project membership.
	DeleteBySlug(ctx context.Context, projectID, userID, slug string) error

	// AttachThread associates a thread with a work item.
	AttachThread(ctx context.Context, workItemID, threadID string) error

	// ListThreads returns a page of threads attached to the work item.
	ListThreads(ctx context.Context, workItemID string, offset, limit int) ([]ThreadSummary, int, error)

	// HasStreamingThreads delegates the streaming check to the store.
	HasStreamingThreads(ctx context.Context, workItemID string) (bool, error)

	// CountActiveEphemerals returns the ephemeral cap usage for a project.
	CountActiveEphemerals(ctx context.Context, projectID string) (int, error)

	// EnsureThreadWorkItem guarantees the thread has an associated work item.
	// If workItemID is non-nil and the referenced work item exists, this is a
	// no-op and returns the existing work item. If workItemID is nil (or the
	// referenced item no longer exists), a new ephemeral work item is created
	// and attached, unless the per-project cap (100) has been reached — in
	// which case the most recent active ephemeral is reused.
	EnsureThreadWorkItem(ctx context.Context, projectID, threadID, userID string, workItemID *string) (*WorkItem, error)
}
