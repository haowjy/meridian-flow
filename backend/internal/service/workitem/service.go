// Package workitem provides business logic for work item lifecycle management.
// Work items group threads under a named artifact folder (.meridian/work/<slug>/).
package workitem

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"meridian/internal/domain"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
	domainwi "meridian/internal/domain/workitem"
	"meridian/internal/service/identifier"
)

// maxActiveEphemerals is the per-project cap on active ephemeral work items.
// When reached, EnsureThreadWorkItem reuses the most recent ephemeral instead
// of creating a new one.
const maxActiveEphemerals = 100

// maxSlugRetries is the maximum number of attempts to generate a unique slug
// before giving up. Guards against TOCTOU races under concurrent creates with
// the same name.
const maxSlugRetries = 5

// workItemService implements domainwi.Service.
type workItemService struct {
	store       domainwi.Store
	projectRepo domaindocsys.ProjectStore
	logger      *slog.Logger
}

// Compile-time interface check.
var _ domainwi.Service = (*workItemService)(nil)

// NewService creates a new work item service.
// projectRepo is used to verify project membership on every mutating operation.
func NewService(store domainwi.Store, projectRepo domaindocsys.ProjectStore, logger *slog.Logger) domainwi.Service {
	return &workItemService{
		store:       store,
		projectRepo: projectRepo,
		logger:      logger,
	}
}

// Create validates the request, generates a unique slug, and persists the work item.
func (s *workItemService) Create(ctx context.Context, projectID, userID string, req *domainwi.CreateRequest) (*domainwi.WorkItem, error) {
	if projectID == "" {
		return nil, domain.NewValidationErrorWithField("project ID is required", "project_id")
	}
	if userID == "" {
		return nil, domain.NewValidationErrorWithField("user ID is required", "user_id")
	}
	if req.Name == "" {
		return nil, domain.NewValidationErrorWithField("name is required", "name")
	}

	// Verify project membership before creating.
	if _, err := s.projectRepo.GetByID(ctx, projectID, userID); err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	baseSlug := identifier.GenerateSlug(req.Name)
	if baseSlug == "" {
		baseSlug = "untitled"
	}

	// Retry loop guards against TOCTOU slug collisions under concurrent creates
	// with the same name. EnsureUniqueSlug probes the store for each candidate;
	// on domain.ErrConflict from the INSERT the probe is re-run so it discovers
	// the newly occupied slug and picks the next available suffix.
	for attempt := 0; attempt < maxSlugRetries; attempt++ {
		slug := identifier.EnsureUniqueSlug(baseSlug, func(candidate string) bool {
			_, err := s.store.GetBySlug(ctx, projectID, candidate)
			return err == nil // exists when no error
		})

		wi := &domainwi.WorkItem{
			ID:          uuid.New().String(),
			ProjectID:   projectID,
			UserID:      userID,
			Name:        req.Name,
			Slug:        slug,
			Description: req.Description,
			Status:      domainwi.StatusActive,
			IsEphemeral: req.IsEphemeral,
			Metadata:    req.Metadata,
			CreatedAt:   now,
			UpdatedAt:   now,
		}

		if err := s.store.Create(ctx, wi); err != nil {
			var conflictErr *domain.ConflictError
			if errors.As(err, &conflictErr) {
				// TOCTOU race: another request inserted this slug between our
				// probe and INSERT. Re-run EnsureUniqueSlug and try again.
				continue
			}
			return nil, err
		}

		s.logger.Info("work item created",
			"id", wi.ID,
			"slug", wi.Slug,
			"project_id", projectID,
			"user_id", userID,
			"ephemeral", wi.IsEphemeral,
		)

		return wi, nil
	}

	return nil, domainerrors.WorkItemSlugGenerationFailed(maxSlugRetries)
}

// Get returns the work item by UUID.
func (s *workItemService) Get(ctx context.Context, id string) (*domainwi.WorkItem, error) {
	if id == "" {
		return nil, domain.NewValidationErrorWithField("id is required", "id")
	}
	return s.store.GetByID(ctx, id)
}

// GetBySlug returns the work item by project + slug.
func (s *workItemService) GetBySlug(ctx context.Context, projectID, userID, slug string) (*domainwi.WorkItem, error) {
	if projectID == "" {
		return nil, domain.NewValidationErrorWithField("project ID is required", "project_id")
	}
	if slug == "" {
		return nil, domain.NewValidationErrorWithField("slug is required", "slug")
	}

	// Verify project membership before exposing any item.
	if _, err := s.projectRepo.GetByID(ctx, projectID, userID); err != nil {
		return nil, err
	}

	return s.store.GetBySlug(ctx, projectID, slug)
}

// List returns a page of non-deleted work items for a project.
func (s *workItemService) List(ctx context.Context, projectID, userID, status string, offset, limit int) ([]domainwi.WorkItem, int, error) {
	if projectID == "" {
		return nil, 0, domain.NewValidationErrorWithField("project ID is required", "project_id")
	}

	// Verify project membership before listing.
	if _, err := s.projectRepo.GetByID(ctx, projectID, userID); err != nil {
		return nil, 0, err
	}

	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	return s.store.ListByProject(ctx, projectID, status, offset, limit)
}

// Update applies a partial patch (name, description, metadata).
func (s *workItemService) Update(ctx context.Context, id, userID string, req *domainwi.UpdateRequest) (*domainwi.WorkItem, error) {
	if id == "" {
		return nil, domain.NewValidationErrorWithField("id is required", "id")
	}

	wi, err := s.store.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// Verify project membership now that we have the projectID from the item.
	if _, err := s.projectRepo.GetByID(ctx, wi.ProjectID, userID); err != nil {
		return nil, err
	}

	// Apply non-nil updates.
	if req.Name != nil {
		if *req.Name == "" {
			return nil, domain.NewValidationErrorWithField("name cannot be empty", "name")
		}
		wi.Name = *req.Name
	}
	if req.ClearDesc {
		wi.Description = nil
	} else if req.Description != nil {
		wi.Description = req.Description
	}
	if req.Metadata != nil {
		wi.Metadata = req.Metadata
	}
	wi.UpdatedAt = time.Now().UTC()

	if err := s.store.Update(ctx, wi); err != nil {
		return nil, err
	}

	s.logger.Debug("work item updated",
		"id", wi.ID,
		"slug", wi.Slug,
	)

	return wi, nil
}

// UpdateBySlug applies a partial patch (name, description, metadata) to a
// work item resolved by project + slug.
func (s *workItemService) UpdateBySlug(ctx context.Context, projectID, userID, slug string, req *domainwi.UpdateRequest) (*domainwi.WorkItem, error) {
	wi, err := s.GetBySlug(ctx, projectID, userID, slug)
	if err != nil {
		return nil, err
	}
	return s.Update(ctx, wi.ID, userID, req)
}

// Complete transitions a work item from active to done.
// Returns 409 if any associated thread has an in-flight streaming turn.
func (s *workItemService) Complete(ctx context.Context, id, userID string) (*domainwi.WorkItem, error) {
	if id == "" {
		return nil, domain.NewValidationErrorWithField("id is required", "id")
	}

	wi, err := s.store.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// Verify project membership now that we have the projectID from the item.
	if _, err := s.projectRepo.GetByID(ctx, wi.ProjectID, userID); err != nil {
		return nil, err
	}

	// Guard: don't allow completing a work item that already has streaming turns.
	streaming, err := s.store.HasStreamingThreads(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("check streaming threads: %w", err)
	}
	if streaming {
		return nil, domainerrors.WorkItemHasActiveStreams(wi.Slug)
	}

	if err := s.store.UpdateStatus(ctx, id, domainwi.StatusActive, domainwi.StatusDone); err != nil {
		// A ConflictError from UpdateStatus means the work item's current status
		// didn't match 'active' — it is already done (or was concurrently completed).
		var conflictErr *domain.ConflictError
		if errors.As(err, &conflictErr) {
			return nil, domainerrors.WorkItemDone(wi.Slug)
		}
		return nil, err
	}

	wi.Status = domainwi.StatusDone
	wi.UpdatedAt = time.Now().UTC()

	s.logger.Info("work item completed", "id", wi.ID, "slug", wi.Slug)

	return wi, nil
}

// CompleteBySlug transitions a work item from active to done by project + slug.
func (s *workItemService) CompleteBySlug(ctx context.Context, projectID, userID, slug string) (*domainwi.WorkItem, error) {
	wi, err := s.GetBySlug(ctx, projectID, userID, slug)
	if err != nil {
		return nil, err
	}
	return s.Complete(ctx, wi.ID, userID)
}

// Reopen transitions a work item from done back to active.
func (s *workItemService) Reopen(ctx context.Context, id, userID string) (*domainwi.WorkItem, error) {
	if id == "" {
		return nil, domain.NewValidationErrorWithField("id is required", "id")
	}

	wi, err := s.store.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// Verify project membership now that we have the projectID from the item.
	if _, err := s.projectRepo.GetByID(ctx, wi.ProjectID, userID); err != nil {
		return nil, err
	}

	if err := s.store.UpdateStatus(ctx, id, domainwi.StatusDone, domainwi.StatusActive); err != nil {
		// CAS mismatch — work item wasn't in 'done' state.
		var conflictErr *domain.ConflictError
		if errors.As(err, &conflictErr) {
			return nil, domainerrors.WorkItemNotDone(wi.Slug)
		}
		return nil, err
	}

	wi.Status = domainwi.StatusActive
	wi.UpdatedAt = time.Now().UTC()

	s.logger.Info("work item reopened", "id", wi.ID, "slug", wi.Slug)

	return wi, nil
}

// ReopenBySlug transitions a work item from done back to active by project + slug.
func (s *workItemService) ReopenBySlug(ctx context.Context, projectID, userID, slug string) (*domainwi.WorkItem, error) {
	wi, err := s.GetBySlug(ctx, projectID, userID, slug)
	if err != nil {
		return nil, err
	}
	return s.Reopen(ctx, wi.ID, userID)
}

// Delete soft-deletes the work item.
func (s *workItemService) Delete(ctx context.Context, id, userID string) (*domainwi.WorkItem, error) {
	if id == "" {
		return nil, domain.NewValidationErrorWithField("id is required", "id")
	}

	// Fetch first so we can return the deleted item and check project membership.
	wi, err := s.store.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// Verify project membership now that we have the projectID from the item.
	if _, err := s.projectRepo.GetByID(ctx, wi.ProjectID, userID); err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	if err := s.store.SoftDelete(ctx, id, now); err != nil {
		return nil, err
	}

	wi.DeletedAt = &now
	wi.UpdatedAt = now

	s.logger.Info("work item deleted", "id", wi.ID, "slug", wi.Slug)

	return wi, nil
}

// DeleteBySlug soft-deletes the work item resolved by project + slug.
func (s *workItemService) DeleteBySlug(ctx context.Context, projectID, userID, slug string) error {
	wi, err := s.GetBySlug(ctx, projectID, userID, slug)
	if err != nil {
		return err
	}

	_, err = s.Delete(ctx, wi.ID, userID)
	return err
}

// AttachThread associates a thread with a work item.
func (s *workItemService) AttachThread(ctx context.Context, workItemID, threadID string) error {
	if workItemID == "" {
		return domain.NewValidationErrorWithField("work item ID is required", "work_item_id")
	}
	if threadID == "" {
		return domain.NewValidationErrorWithField("thread ID is required", "thread_id")
	}
	return s.store.AttachThread(ctx, threadID, workItemID)
}

// ListThreads returns a page of threads attached to the work item.
func (s *workItemService) ListThreads(ctx context.Context, workItemID string, offset, limit int) ([]domainwi.ThreadSummary, int, error) {
	if workItemID == "" {
		return nil, 0, domain.NewValidationErrorWithField("work item ID is required", "work_item_id")
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	return s.store.ListThreads(ctx, workItemID, offset, limit)
}

// HasStreamingThreads delegates the streaming check to the store.
func (s *workItemService) HasStreamingThreads(ctx context.Context, workItemID string) (bool, error) {
	return s.store.HasStreamingThreads(ctx, workItemID)
}

// CountActiveEphemerals returns the ephemeral cap usage for a project.
func (s *workItemService) CountActiveEphemerals(ctx context.Context, projectID string) (int, error) {
	return s.store.CountActiveEphemerals(ctx, projectID)
}

// EnsureThreadWorkItem guarantees the thread has an associated work item.
// If workItemID is non-nil and the referenced work item exists, this is a
// no-op and returns the existing work item. If not, a new ephemeral work item
// is created and attached, unless the per-project cap (100) has been reached —
// in which case the most recent active ephemeral is reused.
// If the most recent ephemeral cannot be found (race condition), falls back to
// creating a new one regardless of cap.
func (s *workItemService) EnsureThreadWorkItem(ctx context.Context, projectID, threadID, userID string, workItemID *string) (*domainwi.WorkItem, error) {
	if projectID == "" {
		return nil, domain.NewValidationErrorWithField("project ID is required", "project_id")
	}
	if threadID == "" {
		return nil, domain.NewValidationErrorWithField("thread ID is required", "thread_id")
	}
	if userID == "" {
		return nil, domain.NewValidationErrorWithField("user ID is required", "user_id")
	}

	// If the thread already has a work item, return it directly (idempotent).
	if workItemID != nil && *workItemID != "" {
		wi, err := s.store.GetByID(ctx, *workItemID)
		if err == nil {
			return wi, nil
		}
		// If the work item was soft-deleted or otherwise missing, fall through
		// to create/reuse an ephemeral below.
		if !errors.Is(err, domain.ErrNotFound) {
			return nil, fmt.Errorf("get existing work item: %w", err)
		}
	}

	count, err := s.store.CountActiveEphemerals(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("count active ephemerals: %w", err)
	}

	var wi *domainwi.WorkItem

	if count < maxActiveEphemerals {
		// Under cap — create a fresh ephemeral work item.
		wi, err = s.Create(ctx, projectID, userID, &domainwi.CreateRequest{
			Name:        "Untitled Work Item",
			IsEphemeral: true,
		})
		if err != nil {
			return nil, fmt.Errorf("create ephemeral work item: %w", err)
		}
	} else {
		// At cap — reuse most recent active ephemeral to avoid unbounded growth.
		wi, err = s.store.GetMostRecentActiveEphemeral(ctx, projectID)
		if err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				// Race condition: all ephemerals were concurrently deleted.
				// Create a new one to unblock the caller.
				s.logger.Warn("ephemeral cap reached but no active ephemerals found; creating new one",
					"project_id", projectID,
				)
				wi, err = s.Create(ctx, projectID, userID, &domainwi.CreateRequest{
					Name:        "Untitled Work Item",
					IsEphemeral: true,
				})
				if err != nil {
					return nil, fmt.Errorf("create fallback ephemeral work item: %w", err)
				}
			} else {
				return nil, fmt.Errorf("get most recent ephemeral: %w", err)
			}
		}
	}

	// Attach the thread to the work item. The store uses a plain UPDATE, which
	// is safe to call even when the thread already points to this work item.
	if err := s.store.AttachThread(ctx, threadID, wi.ID); err != nil {
		return nil, fmt.Errorf("attach thread %s to work item %s: %w", threadID, wi.ID, err)
	}

	s.logger.Debug("thread attached to work item",
		"thread_id", threadID,
		"work_item_id", wi.ID,
		"ephemeral", wi.IsEphemeral,
	)

	return wi, nil
}
