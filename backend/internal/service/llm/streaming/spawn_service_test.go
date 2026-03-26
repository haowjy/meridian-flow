package streaming

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	domainllm "meridian/internal/domain/llm"
)

// testLogger returns a default slog logger suitable for tests.
func testLogger() *slog.Logger {
	return slog.Default()
}

func TestTruncate(t *testing.T) {
	tests := []struct {
		input  string
		maxLen int
		want   string
	}{
		{"hello", 10, "hello"},
		{"hello world this is long", 10, "hello w..."},
		{"hi", 2, "hi"},
		{"hello", 3, "hel"},
		{"", 5, ""},
		{"abc", 3, "abc"},
		{"abcd", 3, "abc"},
		{"abcdefgh", 5, "ab..."},
	}

	for _, tt := range tests {
		got := truncate(tt.input, tt.maxLen)
		if got != tt.want {
			t.Errorf("truncate(%q, %d) = %q, want %q", tt.input, tt.maxLen, got, tt.want)
		}
	}
}

func TestSpawnStatus_Values(t *testing.T) {
	// Verify the spawn status constants match the DB constraint values.
	statuses := []domainllm.SpawnStatus{
		domainllm.SpawnStatusRunning,
		domainllm.SpawnStatusSucceeded,
		domainllm.SpawnStatusFailed,
		domainllm.SpawnStatusCancelled,
		domainllm.SpawnStatusTimedOut,
	}

	expected := []string{"running", "succeeded", "failed", "cancelled", "timed_out"}
	for i, s := range statuses {
		if string(s) != expected[i] {
			t.Errorf("SpawnStatus[%d] = %q, want %q", i, string(s), expected[i])
		}
	}
}

func TestSpawnResult_JSONRoundTrip(t *testing.T) {
	original := &domainllm.SpawnResult{
		ChildThreadID: "test-child-id",
		Status:        "succeeded",
		Summary:       "Found 3 issues in chapters 40-55",
		Artifacts:     []string{"path/to/file1.md", "path/to/file2.md"},
		Metadata: map[string]interface{}{
			"issues_found": float64(3),
		},
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded domainllm.SpawnResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded.ChildThreadID != original.ChildThreadID {
		t.Errorf("ChildThreadID = %q, want %q", decoded.ChildThreadID, original.ChildThreadID)
	}
	if decoded.Status != original.Status {
		t.Errorf("Status = %q, want %q", decoded.Status, original.Status)
	}
	if decoded.Summary != original.Summary {
		t.Errorf("Summary = %q, want %q", decoded.Summary, original.Summary)
	}
	if len(decoded.Artifacts) != len(original.Artifacts) {
		t.Errorf("Artifacts length = %d, want %d", len(decoded.Artifacts), len(original.Artifacts))
	}
}

func TestShutdownCoordinator_NoDrainByDefault(t *testing.T) {
	logger := testLogger()
	coord := NewShutdownCoordinator(DefaultShutdownGracePeriod, logger)

	if coord.IsDraining() {
		t.Error("coordinator should not be draining by default")
	}
	if coord.ActiveCount() != 0 {
		t.Errorf("active count = %d, want 0", coord.ActiveCount())
	}
}

func TestShutdownCoordinator_RegisterDeregister(t *testing.T) {
	logger := testLogger()
	coord := NewShutdownCoordinator(DefaultShutdownGracePeriod, logger)

	ctx := coord.Register(context.Background(), "turn-1")
	if ctx == nil {
		t.Fatal("Register returned nil context")
	}
	if coord.ActiveCount() != 1 {
		t.Errorf("active count = %d, want 1", coord.ActiveCount())
	}

	coord.Deregister("turn-1")
	if coord.ActiveCount() != 0 {
		t.Errorf("active count after deregister = %d, want 0", coord.ActiveCount())
	}
}

func TestShutdownCoordinator_ShutdownNoActive(t *testing.T) {
	logger := testLogger()
	coord := NewShutdownCoordinator(1*time.Second, logger)

	// Shutdown with no active streams should complete immediately.
	done := make(chan struct{})
	go func() {
		coord.Shutdown()
		close(done)
	}()

	select {
	case <-done:
		// OK
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown with no active streams should complete immediately")
	}

	if !coord.IsDraining() {
		t.Error("coordinator should be draining after Shutdown")
	}
}

func TestShutdownCoordinator_ShutdownWaitsForActive(t *testing.T) {
	logger := testLogger()
	coord := NewShutdownCoordinator(5*time.Second, logger)

	// Register an active executor.
	_ = coord.Register(context.Background(), "turn-1")

	shutdownDone := make(chan struct{})
	go func() {
		coord.Shutdown()
		close(shutdownDone)
	}()

	// Give shutdown a moment to start.
	time.Sleep(50 * time.Millisecond)

	if !coord.IsDraining() {
		t.Error("coordinator should be draining after Shutdown called")
	}

	// Deregister the executor — shutdown should complete.
	coord.Deregister("turn-1")

	select {
	case <-shutdownDone:
		// OK
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown should complete after all executors deregister")
	}
}

func TestShutdownCoordinator_ShutdownForceCancels(t *testing.T) {
	logger := testLogger()
	// Very short grace period to trigger force-cancel.
	coord := NewShutdownCoordinator(100*time.Millisecond, logger)

	ctx := coord.Register(context.Background(), "turn-1")

	shutdownDone := make(chan struct{})
	go func() {
		coord.Shutdown()
		close(shutdownDone)
	}()

	// Wait for context to be cancelled by force-cancel.
	select {
	case <-ctx.Done():
		// Context was cancelled — force-cancel worked.
	case <-time.After(5 * time.Second):
		t.Fatal("context should be cancelled after grace period")
	}

	// Deregister so shutdown can complete.
	coord.Deregister("turn-1")

	select {
	case <-shutdownDone:
		// OK
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown should complete after force-cancel and deregister")
	}
}
