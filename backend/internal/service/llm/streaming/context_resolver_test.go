package streaming

// context_resolver_test.go — Unit tests for contextResolver.ResolveWorkContext.
//
// Focus areas:
//   1. Nil / empty workItemID → error (caller must call EnsureThreadWorkItem first)
//   2. Valid work item → correct WorkDir, FSDir, ThreadID, WorkItem slug
//   3. FSDir is always ".meridian/fs" regardless of slug
//   4. WorkDir is always ".meridian/work/<slug>/"
//   5. Store errors are propagated (including ErrNotFound)

import (
	"context"
	"errors"
	"testing"
	"time"

	"meridian/internal/domain"
	domainwi "meridian/internal/domain/workitem"
)

// =============================================================================
// Stub for domainwi.Store — only GetByID is used by contextResolver.
// All other methods panic so unexpected calls fail loudly.
// =============================================================================

type stubWorkItemStore struct {
	item *domainwi.WorkItem
	err  error
}

func (s *stubWorkItemStore) GetByID(_ context.Context, _ string) (*domainwi.WorkItem, error) {
	return s.item, s.err
}

func (s *stubWorkItemStore) GetMostRecentActiveEphemeral(_ context.Context, _ string) (*domainwi.WorkItem, error) {
	panic("stubWorkItemStore.GetMostRecentActiveEphemeral not expected")
}
func (s *stubWorkItemStore) Create(_ context.Context, _ *domainwi.WorkItem) error {
	panic("stubWorkItemStore.Create not expected")
}
func (s *stubWorkItemStore) GetBySlug(_ context.Context, _, _ string) (*domainwi.WorkItem, error) {
	panic("stubWorkItemStore.GetBySlug not expected")
}
func (s *stubWorkItemStore) ListByProject(_ context.Context, _ string, _, _ int) ([]domainwi.WorkItem, int, error) {
	panic("stubWorkItemStore.ListByProject not expected")
}
func (s *stubWorkItemStore) Update(_ context.Context, _ *domainwi.WorkItem) error {
	panic("stubWorkItemStore.Update not expected")
}
func (s *stubWorkItemStore) UpdateStatus(_ context.Context, _ string, _, _ domainwi.Status) error {
	panic("stubWorkItemStore.UpdateStatus not expected")
}
func (s *stubWorkItemStore) SoftDelete(_ context.Context, _ string, _ time.Time) error {
	panic("stubWorkItemStore.SoftDelete not expected")
}
func (s *stubWorkItemStore) AttachThread(_ context.Context, _, _ string) error {
	panic("stubWorkItemStore.AttachThread not expected")
}
func (s *stubWorkItemStore) ListThreads(_ context.Context, _ string, _, _ int) ([]domainwi.ThreadSummary, int, error) {
	panic("stubWorkItemStore.ListThreads not expected")
}
func (s *stubWorkItemStore) HasStreamingThreads(_ context.Context, _ string) (bool, error) {
	panic("stubWorkItemStore.HasStreamingThreads not expected")
}
func (s *stubWorkItemStore) CountAttachedThreads(_ context.Context, _ string) (int, error) {
	panic("stubWorkItemStore.CountAttachedThreads not expected")
}
func (s *stubWorkItemStore) CountActiveEphemerals(_ context.Context, _ string) (int, error) {
	panic("stubWorkItemStore.CountActiveEphemerals not expected")
}

// Compile-time assertion that stubWorkItemStore satisfies domainwi.Store.
var _ domainwi.Store = (*stubWorkItemStore)(nil)

// =============================================================================
// Tests: nil / empty workItemID → error
// =============================================================================

func TestResolveWorkContext_NilWorkItemID_ReturnsError(t *testing.T) {
	// Thread without a work item must produce an error, not a partial ResolvedContext.
	r := NewContextResolver(&stubWorkItemStore{})
	_, err := r.ResolveWorkContext(context.Background(), "thread-1", nil)
	if err == nil {
		t.Fatal("expected error for nil workItemID, got nil")
	}
}

func TestResolveWorkContext_EmptyWorkItemID_ReturnsError(t *testing.T) {
	// An empty string is treated the same as nil — caller must attach a work item first.
	r := NewContextResolver(&stubWorkItemStore{})
	empty := ""
	_, err := r.ResolveWorkContext(context.Background(), "thread-1", &empty)
	if err == nil {
		t.Fatal("expected error for empty workItemID, got nil")
	}
}

// =============================================================================
// Tests: valid work item → correct resolved paths
// =============================================================================

func TestResolveWorkContext_ValidWorkItem_ReturnsCorrectPaths(t *testing.T) {
	// All four fields of ResolvedContext must match the expected values.
	const slug = "my-feature"
	store := &stubWorkItemStore{
		item: &domainwi.WorkItem{ID: "wi-123", Slug: slug},
	}
	r := NewContextResolver(store)
	id := "wi-123"

	got, err := r.ResolveWorkContext(context.Background(), "thread-abc", &id)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if want := ".meridian/work/my-feature/"; got.WorkDir != want {
		t.Errorf("WorkDir = %q, want %q", got.WorkDir, want)
	}
	if got.FSDir != ".meridian/fs" {
		t.Errorf("FSDir = %q, want .meridian/fs", got.FSDir)
	}
	if got.ThreadID != "thread-abc" {
		t.Errorf("ThreadID = %q, want thread-abc", got.ThreadID)
	}
	if got.WorkItem != slug {
		t.Errorf("WorkItem = %q, want %q", got.WorkItem, slug)
	}
}

func TestResolveWorkContext_FSDir_AlwaysFixed(t *testing.T) {
	// FSDir must always be ".meridian/fs" regardless of work item slug.
	for _, slug := range []string{"a", "b-feature", "very-long-work-item-name"} {
		store := &stubWorkItemStore{
			item: &domainwi.WorkItem{ID: "id", Slug: slug},
		}
		r := NewContextResolver(store)
		id := "id"
		got, err := r.ResolveWorkContext(context.Background(), "t", &id)
		if err != nil {
			t.Fatalf("slug=%q: unexpected error: %v", slug, err)
		}
		if got.FSDir != ".meridian/fs" {
			t.Errorf("slug=%q: FSDir = %q, want .meridian/fs", slug, got.FSDir)
		}
	}
}

func TestResolveWorkContext_WorkDir_ContainsSlug(t *testing.T) {
	// WorkDir must be ".meridian/work/<slug>/" for any slug.
	for _, slug := range []string{"a", "my-work", "feature-xyz"} {
		store := &stubWorkItemStore{
			item: &domainwi.WorkItem{ID: "id", Slug: slug},
		}
		r := NewContextResolver(store)
		id := "id"
		got, err := r.ResolveWorkContext(context.Background(), "t", &id)
		if err != nil {
			t.Fatalf("slug=%q: unexpected error: %v", slug, err)
		}
		want := ".meridian/work/" + slug + "/"
		if got.WorkDir != want {
			t.Errorf("slug=%q: WorkDir = %q, want %q", slug, got.WorkDir, want)
		}
	}
}

// =============================================================================
// Tests: store errors are propagated
// =============================================================================

func TestResolveWorkContext_StoreError_Propagates(t *testing.T) {
	// Generic store errors must be wrapped and returned to the caller.
	storeErr := errors.New("db connection failed")
	store := &stubWorkItemStore{err: storeErr}
	r := NewContextResolver(store)
	id := "wi-123"
	_, err := r.ResolveWorkContext(context.Background(), "thread-1", &id)
	if err == nil {
		t.Fatal("expected error from store, got nil")
	}
	if !errors.Is(err, storeErr) {
		t.Errorf("expected wrapped storeErr; got %v", err)
	}
}

func TestResolveWorkContext_NotFound_Propagates(t *testing.T) {
	// domain.ErrNotFound from the store must be detectable via errors.Is.
	store := &stubWorkItemStore{err: domain.ErrNotFound}
	r := NewContextResolver(store)
	id := "nonexistent"
	_, err := r.ResolveWorkContext(context.Background(), "thread-1", &id)
	if err == nil {
		t.Fatal("expected not-found error, got nil")
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("expected ErrNotFound to be wrapped; got %v", err)
	}
}
