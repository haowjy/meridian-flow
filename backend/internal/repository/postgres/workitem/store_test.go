package workitem

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	domainwi "meridian/internal/domain/workitem"
	"meridian/internal/repository/postgres"
)

// integrationHarness provides the store under test and helpers for
// creating prerequisite rows (users, projects, threads).
type integrationHarness struct {
	store  domainwi.Store
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

func setupIntegrationHarness(t *testing.T) *integrationHarness {
	t.Helper()

	dbURL := os.Getenv("SUPABASE_DB_URL")
	if dbURL == "" {
		t.Skip("SUPABASE_DB_URL not set; skipping work item repository integration tests")
	}

	tablePrefix := os.Getenv("TABLE_PREFIX")
	if tablePrefix == "" {
		tablePrefix = "dev_"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := postgres.CreateConnectionPool(ctx, dbURL, 5, 1)
	if err != nil {
		t.Skipf("database unavailable for integration tests: %v", err)
	}
	t.Cleanup(pool.Close)

	tables := postgres.NewTableNames(tablePrefix)
	store := NewWorkItemStore(&postgres.RepositoryConfig{
		Pool:   pool,
		Tables: tables,
		Logger: slog.Default(),
	})

	return &integrationHarness{store: store, pool: pool, tables: tables}
}

// createTestUser inserts a minimal auth.users row and registers cleanup.
// Returns the user UUID string.
func (h *integrationHarness) createTestUser(t *testing.T) string {
	t.Helper()

	userID := uuid.NewString()
	email := fmt.Sprintf("wi-int-%s@example.com", userID[:8])
	ctx := context.Background()

	minimalInsert := `
		INSERT INTO auth.users (
			id, aud, role, email, encrypted_password,
			email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
			created_at, updated_at
		) VALUES (
			$1, 'authenticated', 'authenticated', $2, 'not-used-in-tests',
			NOW(), '{}'::jsonb, '{}'::jsonb, NOW(), NOW()
		)
	`
	if _, err := h.pool.Exec(ctx, minimalInsert, userID, email); err != nil {
		// Try the fallback schema used by some Supabase versions.
		fallback := `
			INSERT INTO auth.users (
				id, instance_id, aud, role, email, encrypted_password,
				email_confirmed_at, confirmation_token, recovery_token,
				email_change_token_new, email_change,
				raw_app_meta_data, raw_user_meta_data, created_at, updated_at
			) VALUES (
				$1, '00000000-0000-0000-0000-000000000000',
				'authenticated', 'authenticated', $2, 'not-used-in-tests',
				NOW(), '', '', '', '',
				'{}'::jsonb, '{}'::jsonb, NOW(), NOW()
			)
		`
		if _, fallbackErr := h.pool.Exec(ctx, fallback, userID, email); fallbackErr != nil {
			t.Skipf("unable to insert auth.users row: %v (fallback: %v)", err, fallbackErr)
		}
	}

	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(), `DELETE FROM auth.users WHERE id = $1`, userID)
	})

	return userID
}

// createTestProject inserts a minimal project row and registers cleanup.
// Returns the project UUID string.
func (h *integrationHarness) createTestProject(t *testing.T, userID string) string {
	t.Helper()

	projectID := uuid.NewString()
	slug := fmt.Sprintf("test-proj-%s", projectID[:8])
	ctx := context.Background()

	query := fmt.Sprintf(`
		INSERT INTO %s (id, user_id, name, slug, created_at, updated_at)
		VALUES ($1, $2, $3, $4, NOW(), NOW())
	`, h.tables.Projects)

	if _, err := h.pool.Exec(ctx, query, projectID, userID, "Test Project", slug); err != nil {
		t.Fatalf("createTestProject: %v", err)
	}

	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(),
			fmt.Sprintf("DELETE FROM %s WHERE id = $1", h.tables.Projects), projectID)
	})

	return projectID
}

// createTestThread inserts a minimal thread row and registers cleanup.
// Returns the thread UUID string.
func (h *integrationHarness) createTestThread(t *testing.T, projectID, userID string) string {
	t.Helper()

	threadID := uuid.NewString()
	ctx := context.Background()

	query := fmt.Sprintf(`
		INSERT INTO %s (id, project_id, user_id, title, created_at, updated_at)
		VALUES ($1, $2, $3, $4, NOW(), NOW())
	`, h.tables.Threads)

	if _, err := h.pool.Exec(ctx, query, threadID, projectID, userID, "Test Thread"); err != nil {
		t.Fatalf("createTestThread: %v", err)
	}

	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(),
			fmt.Sprintf("DELETE FROM %s WHERE id = $1", h.tables.Threads), threadID)
	})

	return threadID
}

// newWorkItem builds a valid WorkItem ready for Create.
func newWorkItem(projectID, userID, slug string) *domainwi.WorkItem {
	now := time.Now().UTC().Truncate(time.Millisecond)
	return &domainwi.WorkItem{
		ProjectID:   projectID,
		UserID:      userID,
		Name:        "Test Work Item",
		Slug:        slug,
		Status:      domainwi.StatusActive,
		IsEphemeral: false,
		Metadata:    map[string]interface{}{"env": "test"},
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

// ============================================================================
// CRUD tests
// ============================================================================

func TestWorkItemStore_Create_GetByID(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	wi := newWorkItem(projectID, userID, "create-get-test")
	if err := h.store.Create(ctx, wi); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if wi.ID == "" {
		t.Fatal("Create: ID not populated after RETURNING")
	}

	got, err := h.store.GetByID(ctx, wi.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.ID != wi.ID {
		t.Errorf("ID = %q, want %q", got.ID, wi.ID)
	}
	if got.Slug != "create-get-test" {
		t.Errorf("Slug = %q, want %q", got.Slug, "create-get-test")
	}
	if got.Status != domainwi.StatusActive {
		t.Errorf("Status = %q, want active", got.Status)
	}
	if got.IsEphemeral != false {
		t.Errorf("IsEphemeral = true, want false")
	}
}

func TestWorkItemStore_GetBySlug(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	wi := newWorkItem(projectID, userID, "slug-lookup-test")
	if err := h.store.Create(ctx, wi); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := h.store.GetBySlug(ctx, projectID, "slug-lookup-test")
	if err != nil {
		t.Fatalf("GetBySlug: %v", err)
	}
	if got.ID != wi.ID {
		t.Errorf("ID = %q, want %q", got.ID, wi.ID)
	}

	// Non-existent slug returns NotFound.
	_, err = h.store.GetBySlug(ctx, projectID, "no-such-slug")
	if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("GetBySlug(missing) error = %v, want ErrNotFound", err)
	}
}

func TestWorkItemStore_Update(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	wi := newWorkItem(projectID, userID, "update-test")
	if err := h.store.Create(ctx, wi); err != nil {
		t.Fatalf("Create: %v", err)
	}

	desc := "updated description"
	wi.Name = "Updated Name"
	wi.Description = &desc
	wi.Metadata = map[string]interface{}{"key": "val"}
	wi.UpdatedAt = time.Now().UTC()

	if err := h.store.Update(ctx, wi); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got, err := h.store.GetByID(ctx, wi.ID)
	if err != nil {
		t.Fatalf("GetByID after update: %v", err)
	}
	if got.Name != "Updated Name" {
		t.Errorf("Name = %q, want %q", got.Name, "Updated Name")
	}
	if got.Description == nil || *got.Description != desc {
		t.Errorf("Description = %v, want %q", got.Description, desc)
	}
}

func TestWorkItemStore_SoftDelete(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	wi := newWorkItem(projectID, userID, "soft-delete-test")
	if err := h.store.Create(ctx, wi); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := h.store.SoftDelete(ctx, wi.ID, time.Now().UTC()); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}

	// Item should be invisible to GetByID after soft-delete.
	_, err := h.store.GetByID(ctx, wi.ID)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("GetByID after delete error = %v, want ErrNotFound", err)
	}

	// Second SoftDelete on already-deleted item returns NotFound.
	err = h.store.SoftDelete(ctx, wi.ID, time.Now().UTC())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("second SoftDelete error = %v, want ErrNotFound", err)
	}
}

// ============================================================================
// Status transition tests
// ============================================================================

func TestWorkItemStore_UpdateStatus_ActiveToDone(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	wi := newWorkItem(projectID, userID, "status-transition")
	if err := h.store.Create(ctx, wi); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := h.store.UpdateStatus(ctx, wi.ID, domainwi.StatusActive, domainwi.StatusDone); err != nil {
		t.Fatalf("UpdateStatus active->done: %v", err)
	}

	got, err := h.store.GetByID(ctx, wi.ID)
	if err != nil {
		t.Fatalf("GetByID after status change: %v", err)
	}
	if got.Status != domainwi.StatusDone {
		t.Errorf("Status = %q, want done", got.Status)
	}
}

func TestWorkItemStore_UpdateStatus_WrongFromReturnsConflict(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	wi := newWorkItem(projectID, userID, "status-conflict")
	if err := h.store.Create(ctx, wi); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Attempt done->active on an item that is still active.
	err := h.store.UpdateStatus(ctx, wi.ID, domainwi.StatusDone, domainwi.StatusActive)
	if !errors.Is(err, domain.ErrConflict) {
		t.Errorf("UpdateStatus(wrong from) error = %v, want ErrConflict", err)
	}
}

func TestWorkItemStore_UpdateStatus_MissingReturnsNotFound(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	err := h.store.UpdateStatus(ctx, uuid.NewString(), domainwi.StatusActive, domainwi.StatusDone)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("UpdateStatus(missing) error = %v, want ErrNotFound", err)
	}
}

// ============================================================================
// Partial unique index — slug collision
// ============================================================================

func TestWorkItemStore_Create_DuplicateSlugConflict(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	slug := "collision-slug"
	wi1 := newWorkItem(projectID, userID, slug)
	if err := h.store.Create(ctx, wi1); err != nil {
		t.Fatalf("Create first: %v", err)
	}

	wi2 := newWorkItem(projectID, userID, slug)
	err := h.store.Create(ctx, wi2)
	if !errors.Is(err, domain.ErrConflict) {
		t.Errorf("Create duplicate slug error = %v, want ErrConflict", err)
	}
}

func TestWorkItemStore_Create_SlugReusableAfterSoftDelete(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	slug := "reuse-after-delete"
	wi1 := newWorkItem(projectID, userID, slug)
	if err := h.store.Create(ctx, wi1); err != nil {
		t.Fatalf("Create first: %v", err)
	}

	if err := h.store.SoftDelete(ctx, wi1.ID, time.Now().UTC()); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}

	// Partial unique index is WHERE deleted_at IS NULL, so the slug is free again.
	wi2 := newWorkItem(projectID, userID, slug)
	if err := h.store.Create(ctx, wi2); err != nil {
		t.Errorf("Create after soft-delete should succeed, got: %v", err)
	}
}

// ============================================================================
// Pagination — ListByProject
// ============================================================================

func TestWorkItemStore_ListByProject_Pagination(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	// Create 5 work items; slugs must be unique and match the slug regex.
	slugs := []string{"item-a", "item-b", "item-c", "item-d", "item-e"}
	for _, slug := range slugs {
		wi := newWorkItem(projectID, userID, slug)
		if err := h.store.Create(ctx, wi); err != nil {
			t.Fatalf("Create %s: %v", slug, err)
		}
	}

	// Page 1: limit 2, offset 0.
	page1, total, err := h.store.ListByProject(ctx, projectID, "", 0, 2)
	if err != nil {
		t.Fatalf("ListByProject page1: %v", err)
	}
	if total != 5 {
		t.Errorf("total = %d, want 5", total)
	}
	if len(page1) != 2 {
		t.Errorf("page1 len = %d, want 2", len(page1))
	}

	// Page 2: limit 2, offset 2.
	page2, total2, err := h.store.ListByProject(ctx, projectID, "", 2, 2)
	if err != nil {
		t.Fatalf("ListByProject page2: %v", err)
	}
	if total2 != 5 {
		t.Errorf("total2 = %d, want 5", total2)
	}
	if len(page2) != 2 {
		t.Errorf("page2 len = %d, want 2", len(page2))
	}

	// Page 3: last item.
	page3, _, err := h.store.ListByProject(ctx, projectID, "", 4, 2)
	if err != nil {
		t.Fatalf("ListByProject page3: %v", err)
	}
	if len(page3) != 1 {
		t.Errorf("page3 len = %d, want 1", len(page3))
	}

	// Items must be ordered created_at DESC; IDs in pages must not repeat.
	seen := map[string]bool{}
	for _, wi := range append(append(page1, page2...), page3...) {
		if seen[wi.ID] {
			t.Errorf("duplicate ID %s in paginated results", wi.ID)
		}
		seen[wi.ID] = true
	}
	if len(seen) != 5 {
		t.Errorf("unique IDs across pages = %d, want 5", len(seen))
	}
}

func TestWorkItemStore_ListByProject_EmptyProject(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	items, total, err := h.store.ListByProject(ctx, projectID, "", 0, 20)
	if err != nil {
		t.Fatalf("ListByProject empty: %v", err)
	}
	if total != 0 {
		t.Errorf("total = %d, want 0", total)
	}
	if len(items) != 0 {
		t.Errorf("items len = %d, want 0", len(items))
	}
}

// ============================================================================
// Thread attachment
// ============================================================================

func TestWorkItemStore_AttachThread_ListThreads(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)
	threadID := h.createTestThread(t, projectID, userID)

	wi := newWorkItem(projectID, userID, "attach-thread-test")
	if err := h.store.Create(ctx, wi); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := h.store.AttachThread(ctx, threadID, wi.ID); err != nil {
		t.Fatalf("AttachThread: %v", err)
	}

	count, err := h.store.CountAttachedThreads(ctx, wi.ID)
	if err != nil {
		t.Fatalf("CountAttachedThreads: %v", err)
	}
	if count != 1 {
		t.Errorf("CountAttachedThreads = %d, want 1", count)
	}

	threads, total, err := h.store.ListThreads(ctx, wi.ID, 0, 20)
	if err != nil {
		t.Fatalf("ListThreads: %v", err)
	}
	if total != 1 {
		t.Errorf("ListThreads total = %d, want 1", total)
	}
	if len(threads) != 1 {
		t.Fatalf("ListThreads len = %d, want 1", len(threads))
	}
	if threads[0].ID != threadID {
		t.Errorf("thread ID = %q, want %q", threads[0].ID, threadID)
	}
	// ThreadSummary must carry the work_item_id back.
	if threads[0].WorkItemID == nil || *threads[0].WorkItemID != wi.ID {
		t.Errorf("ThreadSummary.WorkItemID = %v, want %q", threads[0].WorkItemID, wi.ID)
	}
}

func TestWorkItemStore_AttachThread_NonExistentThreadReturnsNotFound(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	wi := newWorkItem(projectID, userID, "attach-missing-thread")
	if err := h.store.Create(ctx, wi); err != nil {
		t.Fatalf("Create: %v", err)
	}

	err := h.store.AttachThread(ctx, uuid.NewString(), wi.ID)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("AttachThread(missing thread) error = %v, want ErrNotFound", err)
	}
}

// ============================================================================
// CountActiveEphemerals
// ============================================================================

func TestWorkItemStore_CountActiveEphemerals(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)

	// Start: 0 ephemerals.
	count, err := h.store.CountActiveEphemerals(ctx, projectID)
	if err != nil {
		t.Fatalf("CountActiveEphemerals baseline: %v", err)
	}
	if count != 0 {
		t.Errorf("baseline count = %d, want 0", count)
	}

	// Add two ephemeral work items.
	for _, slug := range []string{"ephemeral-one", "ephemeral-two"} {
		wi := newWorkItem(projectID, userID, slug)
		wi.IsEphemeral = true
		if err := h.store.Create(ctx, wi); err != nil {
			t.Fatalf("Create ephemeral %s: %v", slug, err)
		}
	}

	// Add one non-ephemeral — must not count.
	wiReal := newWorkItem(projectID, userID, "real-item")
	wiReal.IsEphemeral = false
	if err := h.store.Create(ctx, wiReal); err != nil {
		t.Fatalf("Create real: %v", err)
	}

	count, err = h.store.CountActiveEphemerals(ctx, projectID)
	if err != nil {
		t.Fatalf("CountActiveEphemerals after creates: %v", err)
	}
	if count != 2 {
		t.Errorf("count after 2 ephemerals = %d, want 2", count)
	}

	// Soft-delete one ephemeral — should reduce count.
	items, _, err := h.store.ListByProject(ctx, projectID, "", 0, 10)
	if err != nil {
		t.Fatalf("ListByProject: %v", err)
	}
	var ephemeralID string
	for _, it := range items {
		if it.IsEphemeral {
			ephemeralID = it.ID
			break
		}
	}
	if ephemeralID == "" {
		t.Fatal("could not find ephemeral item to delete")
	}
	if err := h.store.SoftDelete(ctx, ephemeralID, time.Now().UTC()); err != nil {
		t.Fatalf("SoftDelete ephemeral: %v", err)
	}

	count, err = h.store.CountActiveEphemerals(ctx, projectID)
	if err != nil {
		t.Fatalf("CountActiveEphemerals after delete: %v", err)
	}
	if count != 1 {
		t.Errorf("count after delete = %d, want 1", count)
	}
}

// ============================================================================
// HasStreamingThreads — verified via direct SQL injection of a turn row.
// ============================================================================

func TestWorkItemStore_HasStreamingThreads(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	userID := h.createTestUser(t)
	projectID := h.createTestProject(t, userID)
	threadID := h.createTestThread(t, projectID, userID)

	wi := newWorkItem(projectID, userID, "streaming-check")
	if err := h.store.Create(ctx, wi); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := h.store.AttachThread(ctx, threadID, wi.ID); err != nil {
		t.Fatalf("AttachThread: %v", err)
	}

	// No turns yet — should be false.
	has, err := h.store.HasStreamingThreads(ctx, wi.ID)
	if err != nil {
		t.Fatalf("HasStreamingThreads (no turns): %v", err)
	}
	if has {
		t.Error("HasStreamingThreads = true, want false (no turns yet)")
	}

	// Insert a streaming turn directly.
	turnID := uuid.NewString()
	insertTurn := fmt.Sprintf(`
		INSERT INTO %s (id, thread_id, role, status, created_at)
		VALUES ($1, $2, 'assistant', 'streaming', NOW())
	`, h.tables.Turns)
	if _, err := h.pool.Exec(ctx, insertTurn, turnID, threadID); err != nil {
		t.Fatalf("insert streaming turn: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(),
			fmt.Sprintf("DELETE FROM %s WHERE id = $1", h.tables.Turns), turnID)
	})

	has, err = h.store.HasStreamingThreads(ctx, wi.ID)
	if err != nil {
		t.Fatalf("HasStreamingThreads (with streaming turn): %v", err)
	}
	if !has {
		t.Error("HasStreamingThreads = false, want true (streaming turn present)")
	}
}
