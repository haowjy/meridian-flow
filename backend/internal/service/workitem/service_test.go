package workitem_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"testing"
	"time"

	"meridian/internal/domain"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
	domainwi "meridian/internal/domain/workitem"
	svcwi "meridian/internal/service/workitem"
)

// ---------------------------------------------------------------------------
// Mock Store
// ---------------------------------------------------------------------------

// mockStore is a fully configurable in-memory mock for domainwi.Store.
type mockStore struct {
	items map[string]*domainwi.WorkItem // by ID
	slugs map[string]map[string]string  // projectID → slug → ID

	createErr                 error
	getByIDErr                error
	getBySlugErr              error
	updateErr                 error
	updateStatusErr           error
	softDeleteErr             error
	attachThreadErr           error
	hasStreamingThreads       bool
	hasStreamingThreadsErr    error
	countAttachedThreads      int
	countActiveEphemerals     int
	countActiveEphemeralsErr  error
	mostRecentEphemeral       *domainwi.WorkItem
	getMostRecentEphemeralErr error
	listThreadsSummaries      []domainwi.ThreadSummary
	listThreadsTotal          int
	listByProjectItems        []domainwi.WorkItem
	listByProjectTotal        int
}

func newMockStore() *mockStore {
	return &mockStore{
		items: make(map[string]*domainwi.WorkItem),
		slugs: make(map[string]map[string]string),
	}
}

func (m *mockStore) Create(ctx context.Context, item *domainwi.WorkItem) error {
	if m.createErr != nil {
		return m.createErr
	}
	// Simulate PG duplicate slug error
	if m.slugs[item.ProjectID] == nil {
		m.slugs[item.ProjectID] = make(map[string]string)
	}
	if _, exists := m.slugs[item.ProjectID][item.Slug]; exists {
		return domain.NewConflictError("work_item", item.Slug, "slug already exists")
	}
	m.slugs[item.ProjectID][item.Slug] = item.ID
	cp := *item
	m.items[item.ID] = &cp
	return nil
}

func (m *mockStore) GetByID(ctx context.Context, id string) (*domainwi.WorkItem, error) {
	if m.getByIDErr != nil {
		return nil, m.getByIDErr
	}
	wi, ok := m.items[id]
	if !ok {
		return nil, domain.NewNotFoundError("work_item", "not found")
	}
	cp := *wi
	return &cp, nil
}

func (m *mockStore) GetBySlug(ctx context.Context, projectID, slug string) (*domainwi.WorkItem, error) {
	if m.getBySlugErr != nil {
		return nil, m.getBySlugErr
	}
	slugMap, ok := m.slugs[projectID]
	if !ok {
		return nil, domain.NewNotFoundError("work_item", "not found")
	}
	id, ok := slugMap[slug]
	if !ok {
		return nil, domain.NewNotFoundError("work_item", "not found")
	}
	wi, ok := m.items[id]
	if !ok {
		return nil, domain.NewNotFoundError("work_item", "not found")
	}
	cp := *wi
	return &cp, nil
}

func (m *mockStore) ListByProject(ctx context.Context, projectID, status string, offset, limit int) ([]domainwi.WorkItem, int, error) {
	return m.listByProjectItems, m.listByProjectTotal, nil
}

func (m *mockStore) Update(ctx context.Context, item *domainwi.WorkItem) error {
	if m.updateErr != nil {
		return m.updateErr
	}
	if _, ok := m.items[item.ID]; !ok {
		return domain.NewNotFoundError("work_item", "not found")
	}
	cp := *item
	m.items[item.ID] = &cp
	return nil
}

func (m *mockStore) UpdateStatus(ctx context.Context, id string, from, to domainwi.Status) error {
	if m.updateStatusErr != nil {
		return m.updateStatusErr
	}
	wi, ok := m.items[id]
	if !ok {
		return domain.NewNotFoundError("work_item", "not found")
	}
	if wi.Status != from {
		return domain.NewConflictError("work_item", id, "status mismatch")
	}
	wi.Status = to
	wi.UpdatedAt = time.Now().UTC()
	return nil
}

func (m *mockStore) SoftDelete(ctx context.Context, id string, deletedAt time.Time) error {
	if m.softDeleteErr != nil {
		return m.softDeleteErr
	}
	wi, ok := m.items[id]
	if !ok {
		return domain.NewNotFoundError("work_item", "not found")
	}
	wi.DeletedAt = &deletedAt
	return nil
}

func (m *mockStore) AttachThread(ctx context.Context, threadID, workItemID string) error {
	return m.attachThreadErr
}

func (m *mockStore) ListThreads(ctx context.Context, workItemID string, offset, limit int) ([]domainwi.ThreadSummary, int, error) {
	return m.listThreadsSummaries, m.listThreadsTotal, nil
}

func (m *mockStore) HasStreamingThreads(ctx context.Context, workItemID string) (bool, error) {
	return m.hasStreamingThreads, m.hasStreamingThreadsErr
}

func (m *mockStore) CountAttachedThreads(ctx context.Context, workItemID string) (int, error) {
	return m.countAttachedThreads, nil
}

func (m *mockStore) CountActiveEphemerals(ctx context.Context, projectID string) (int, error) {
	if m.countActiveEphemeralsErr != nil {
		return 0, m.countActiveEphemeralsErr
	}
	return m.countActiveEphemerals, nil
}

func (m *mockStore) GetMostRecentActiveEphemeral(ctx context.Context, projectID string) (*domainwi.WorkItem, error) {
	if m.getMostRecentEphemeralErr != nil {
		return nil, m.getMostRecentEphemeralErr
	}
	if m.mostRecentEphemeral == nil {
		return nil, domain.NewNotFoundError("work_item", "no ephemeral found")
	}
	cp := *m.mostRecentEphemeral
	return &cp, nil
}

// ---------------------------------------------------------------------------
// Mock Project Store
// ---------------------------------------------------------------------------

// mockProjectStore is a minimal domaindocsys.ProjectStore that always grants
// project access. Unit tests focus on work-item logic, not membership rules.
type mockProjectStore struct {
	getByIDErr error
}

func (m *mockProjectStore) GetByID(ctx context.Context, id, userID string) (*domaindocsys.Project, error) {
	if m.getByIDErr != nil {
		return nil, m.getByIDErr
	}
	return &domaindocsys.Project{ID: id, UserID: userID}, nil
}

func (m *mockProjectStore) Create(ctx context.Context, project *domaindocsys.Project) error {
	return nil
}
func (m *mockProjectStore) GetByIDOnly(ctx context.Context, id string) (*domaindocsys.Project, error) {
	return &domaindocsys.Project{ID: id}, nil
}
func (m *mockProjectStore) GetBySlug(ctx context.Context, slug, userID string) (*domaindocsys.Project, error) {
	return nil, domain.NewNotFoundError("project", "not found")
}
func (m *mockProjectStore) SlugExists(ctx context.Context, slug, userID string, excludeID *string) (bool, error) {
	return false, nil
}
func (m *mockProjectStore) List(ctx context.Context, userID string) ([]domaindocsys.Project, error) {
	return nil, nil
}
func (m *mockProjectStore) Update(ctx context.Context, project *domaindocsys.Project) error {
	return nil
}
func (m *mockProjectStore) Delete(ctx context.Context, id, userID string) (*domaindocsys.Project, error) {
	return nil, nil
}
func (m *mockProjectStore) TouchLastActivityAt(ctx context.Context, projectID string) error {
	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func newTestService(store domainwi.Store) domainwi.Service {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	return svcwi.NewService(store, &mockProjectStore{}, logger)
}

func newActiveWorkItem(id, projectID, slug string) *domainwi.WorkItem {
	return &domainwi.WorkItem{
		ID:        id,
		ProjectID: projectID,
		UserID:    "user-1",
		Name:      "My Work Item",
		Slug:      slug,
		Status:    domainwi.StatusActive,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
}

// ---------------------------------------------------------------------------
// Tests: Create
// ---------------------------------------------------------------------------

func TestCreate_Success(t *testing.T) {
	store := newMockStore()
	svc := newTestService(store)

	wi, err := svc.Create(context.Background(), "proj-1", "user-1", &domainwi.CreateRequest{Name: "My Feature"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if wi == nil {
		t.Fatal("expected work item, got nil")
	}
	if wi.Slug != "my-feature" {
		t.Errorf("expected slug 'my-feature', got %q", wi.Slug)
	}
	if wi.Status != domainwi.StatusActive {
		t.Errorf("expected status active, got %q", wi.Status)
	}
	if wi.ProjectID != "proj-1" {
		t.Errorf("expected project_id 'proj-1', got %q", wi.ProjectID)
	}
}

func TestCreate_SlugCollision_Appends_Suffix(t *testing.T) {
	store := newMockStore()
	svc := newTestService(store)

	ctx := context.Background()

	// Create first item with slug "my-feature"
	_, err := svc.Create(ctx, "proj-1", "user-1", &domainwi.CreateRequest{Name: "My Feature"})
	if err != nil {
		t.Fatalf("first create: %v", err)
	}

	// Create second item with same name — should get "my-feature-2"
	wi2, err := svc.Create(ctx, "proj-1", "user-1", &domainwi.CreateRequest{Name: "My Feature"})
	if err != nil {
		t.Fatalf("second create: %v", err)
	}
	if wi2.Slug != "my-feature-2" {
		t.Errorf("expected slug 'my-feature-2', got %q", wi2.Slug)
	}

	// Third collision → "my-feature-3"
	wi3, err := svc.Create(ctx, "proj-1", "user-1", &domainwi.CreateRequest{Name: "My Feature"})
	if err != nil {
		t.Fatalf("third create: %v", err)
	}
	if wi3.Slug != "my-feature-3" {
		t.Errorf("expected slug 'my-feature-3', got %q", wi3.Slug)
	}
}

func TestCreate_EmptyName_Error(t *testing.T) {
	store := newMockStore()
	svc := newTestService(store)

	_, err := svc.Create(context.Background(), "proj-1", "user-1", &domainwi.CreateRequest{Name: ""})
	if err == nil {
		t.Fatal("expected error for empty name")
	}
	var ve *domain.ValidationError
	if !errors.As(err, &ve) {
		t.Errorf("expected ValidationError, got %T: %v", err, err)
	}
}

// ---------------------------------------------------------------------------
// Tests: Complete
// ---------------------------------------------------------------------------

func TestComplete_Success(t *testing.T) {
	store := newMockStore()
	wi := newActiveWorkItem("wi-1", "proj-1", "my-feature")
	store.items["wi-1"] = wi
	store.slugs["proj-1"] = map[string]string{"my-feature": "wi-1"}

	svc := newTestService(store)

	updated, err := svc.Complete(context.Background(), "wi-1", "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Status != domainwi.StatusDone {
		t.Errorf("expected status done, got %q", updated.Status)
	}
}

func TestComplete_WithActiveStream_Returns409(t *testing.T) {
	store := newMockStore()
	wi := newActiveWorkItem("wi-1", "proj-1", "my-feature")
	store.items["wi-1"] = wi
	store.hasStreamingThreads = true

	svc := newTestService(store)

	_, err := svc.Complete(context.Background(), "wi-1", "user-1")
	if err == nil {
		t.Fatal("expected error for streaming threads")
	}

	var de *domainerrors.DomainError
	if !errors.As(err, &de) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodeWorkItemHasActiveStreams {
		t.Errorf("expected code %q, got %q", domainerrors.CodeWorkItemHasActiveStreams, de.Code)
	}
	if de.Status != 409 {
		t.Errorf("expected HTTP 409, got %d", de.Status)
	}
}

func TestComplete_AlreadyDone_Returns409(t *testing.T) {
	store := newMockStore()
	wi := newActiveWorkItem("wi-1", "proj-1", "my-feature")
	wi.Status = domainwi.StatusDone
	store.items["wi-1"] = wi

	svc := newTestService(store)

	_, err := svc.Complete(context.Background(), "wi-1", "user-1")
	if err == nil {
		t.Fatal("expected error for already-done work item")
	}

	var de *domainerrors.DomainError
	if !errors.As(err, &de) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodeWorkItemDone {
		t.Errorf("expected code %q, got %q", domainerrors.CodeWorkItemDone, de.Code)
	}
}

// ---------------------------------------------------------------------------
// Tests: Reopen
// ---------------------------------------------------------------------------

func TestReopen_Success(t *testing.T) {
	store := newMockStore()
	wi := newActiveWorkItem("wi-1", "proj-1", "my-feature")
	wi.Status = domainwi.StatusDone
	store.items["wi-1"] = wi

	svc := newTestService(store)

	updated, err := svc.Reopen(context.Background(), "wi-1", "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Status != domainwi.StatusActive {
		t.Errorf("expected status active, got %q", updated.Status)
	}
}

func TestReopen_ActiveItem_Returns409DomainError(t *testing.T) {
	store := newMockStore()
	wi := newActiveWorkItem("wi-1", "proj-1", "my-feature")
	store.items["wi-1"] = wi

	svc := newTestService(store)

	_, err := svc.Reopen(context.Background(), "wi-1", "user-1")
	if err == nil {
		t.Fatal("expected error for active work item")
	}

	var de *domainerrors.DomainError
	if !errors.As(err, &de) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodeWorkItemNotDone {
		t.Errorf("expected code %q, got %q", domainerrors.CodeWorkItemNotDone, de.Code)
	}
	if de.Status != 409 {
		t.Errorf("expected HTTP 409, got %d", de.Status)
	}
}

// ---------------------------------------------------------------------------
// Tests: Delete
// ---------------------------------------------------------------------------

func TestDelete_Success(t *testing.T) {
	store := newMockStore()
	wi := newActiveWorkItem("wi-1", "proj-1", "my-feature")
	store.items["wi-1"] = wi

	svc := newTestService(store)

	deleted, err := svc.Delete(context.Background(), "wi-1", "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if deleted.DeletedAt == nil {
		t.Error("expected DeletedAt to be set")
	}
}

func TestDelete_NotFound_Returns404(t *testing.T) {
	store := newMockStore()
	svc := newTestService(store)

	_, err := svc.Delete(context.Background(), "nonexistent", "user-1")
	if err == nil {
		t.Fatal("expected error for nonexistent work item")
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("expected not-found error, got %T: %v", err, err)
	}
}

// ---------------------------------------------------------------------------
// Tests: EnsureThreadWorkItem
// ---------------------------------------------------------------------------

func TestEnsureThreadWorkItem_UnderCap_CreatesNew(t *testing.T) {
	store := newMockStore()
	store.countActiveEphemerals = 0

	svc := newTestService(store)

	wi, err := svc.EnsureThreadWorkItem(context.Background(), "proj-1", "thread-1", "user-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if wi == nil {
		t.Fatal("expected work item, got nil")
	}
	if !wi.IsEphemeral {
		t.Error("expected ephemeral work item")
	}
}

func TestEnsureThreadWorkItem_AtCap_ReusesExisting(t *testing.T) {
	store := newMockStore()
	store.countActiveEphemerals = 100 // at cap

	existing := newActiveWorkItem("existing-wi", "proj-1", "untitled-work-item")
	existing.IsEphemeral = true
	store.mostRecentEphemeral = existing

	svc := newTestService(store)

	wi, err := svc.EnsureThreadWorkItem(context.Background(), "proj-1", "thread-1", "user-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if wi.ID != "existing-wi" {
		t.Errorf("expected existing-wi, got %q", wi.ID)
	}
}

func TestEnsureThreadWorkItem_AtCapNoEphemeral_CreatesNew(t *testing.T) {
	store := newMockStore()
	store.countActiveEphemerals = 100 // at cap
	// GetMostRecentActiveEphemeral returns not found
	store.getMostRecentEphemeralErr = domain.NewNotFoundError("work_item", "none")

	svc := newTestService(store)

	// Should fall back to creating a new ephemeral even at cap
	wi, err := svc.EnsureThreadWorkItem(context.Background(), "proj-1", "thread-1", "user-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !wi.IsEphemeral {
		t.Error("expected ephemeral work item")
	}
}

// ---------------------------------------------------------------------------
// Tests: List
// ---------------------------------------------------------------------------

func TestList_ReturnsItems(t *testing.T) {
	store := newMockStore()
	store.listByProjectItems = []domainwi.WorkItem{
		*newActiveWorkItem("wi-1", "proj-1", "slug-1"),
		*newActiveWorkItem("wi-2", "proj-1", "slug-2"),
	}
	store.listByProjectTotal = 2

	svc := newTestService(store)

	items, total, err := svc.List(context.Background(), "proj-1", "user-1", "", 0, 20)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 2 {
		t.Errorf("expected total 2, got %d", total)
	}
	if len(items) != 2 {
		t.Errorf("expected 2 items, got %d", len(items))
	}
}

// ---------------------------------------------------------------------------
// Tests: Update
// ---------------------------------------------------------------------------

func TestUpdate_PartialFields(t *testing.T) {
	store := newMockStore()
	wi := newActiveWorkItem("wi-1", "proj-1", "my-feature")
	store.items["wi-1"] = wi

	svc := newTestService(store)

	newName := "Renamed Feature"
	updated, err := svc.Update(context.Background(), "wi-1", "user-1", &domainwi.UpdateRequest{
		Name: &newName,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Name != "Renamed Feature" {
		t.Errorf("expected name 'Renamed Feature', got %q", updated.Name)
	}
	// Slug should not change
	if updated.Slug != "my-feature" {
		t.Errorf("expected slug unchanged 'my-feature', got %q", updated.Slug)
	}
}

func TestUpdate_ClearDescription(t *testing.T) {
	store := newMockStore()
	desc := "initial description"
	wi := newActiveWorkItem("wi-1", "proj-1", "my-feature")
	wi.Description = &desc
	store.items["wi-1"] = wi

	svc := newTestService(store)

	updated, err := svc.Update(context.Background(), "wi-1", "user-1", &domainwi.UpdateRequest{
		ClearDesc: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Description != nil {
		t.Errorf("expected nil description, got %q", *updated.Description)
	}
}
