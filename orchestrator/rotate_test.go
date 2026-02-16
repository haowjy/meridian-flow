package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTestFile is a test helper that writes a file and fails the test on error.
func writeTestFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(path, content, 0644); err != nil {
		t.Fatalf("writing test file %s: %v", path, err)
	}
}

func TestRotateTasks(t *testing.T) {
	dir := t.TempDir()

	// Create current.md and cleanup files
	writeTestFile(t, filepath.Join(dir, "current.md"), []byte("## Task 1\nDo stuff"))
	writeTestFile(t, filepath.Join(dir, "cleanup-001.md"), []byte("fix lint"))
	writeTestFile(t, filepath.Join(dir, "cleanup-002.md"), []byte("remove dead code"))

	if err := RotateTasks(dir); err != nil {
		t.Fatalf("RotateTasks failed: %v", err)
	}

	// current.md should be gone
	if _, err := os.Stat(filepath.Join(dir, "current.md")); !os.IsNotExist(err) {
		t.Error("current.md should be removed after rotation")
	}

	// cleanup files should be gone
	matches, _ := filepath.Glob(filepath.Join(dir, "cleanup-*.md"))
	if len(matches) > 0 {
		t.Errorf("cleanup files should be removed, found: %v", matches)
	}

	// progress.md should contain current.md content + separator
	progress, err := os.ReadFile(filepath.Join(dir, "progress.md"))
	if err != nil {
		t.Fatalf("reading progress.md: %v", err)
	}
	if !strings.Contains(string(progress), "## Task 1") {
		t.Error("progress.md should contain current.md content")
	}
	if !strings.Contains(string(progress), "---") {
		t.Error("progress.md should contain separator")
	}
}

func TestRotateTasks_NoCurrent(t *testing.T) {
	dir := t.TempDir()

	// Should not error when current.md doesn't exist
	if err := RotateTasks(dir); err != nil {
		t.Fatalf("RotateTasks failed with no current.md: %v", err)
	}
}

func TestRotateTasks_AppendToExistingProgress(t *testing.T) {
	dir := t.TempDir()

	// Pre-existing progress
	writeTestFile(t, filepath.Join(dir, "progress.md"), []byte("## Old Task\nDone\n---\n\n"))
	writeTestFile(t, filepath.Join(dir, "current.md"), []byte("## New Task\nAlso done"))

	if err := RotateTasks(dir); err != nil {
		t.Fatalf("RotateTasks failed: %v", err)
	}

	progress, err := os.ReadFile(filepath.Join(dir, "progress.md"))
	if err != nil {
		t.Fatalf("reading progress.md: %v", err)
	}
	content := string(progress)
	if !strings.Contains(content, "## Old Task") {
		t.Error("progress.md should preserve old content")
	}
	if !strings.Contains(content, "## New Task") {
		t.Error("progress.md should contain new content")
	}
}

func TestIsAllDone(t *testing.T) {
	dir := t.TempDir()

	// No file
	if IsAllDone(dir) {
		t.Error("IsAllDone should be false when current.md doesn't exist")
	}

	// File with ALL_DONE
	writeTestFile(t, filepath.Join(dir, "current.md"), []byte("ALL_DONE"))
	if !IsAllDone(dir) {
		t.Error("IsAllDone should be true when current.md contains ALL_DONE")
	}

	// File without ALL_DONE
	writeTestFile(t, filepath.Join(dir, "current.md"), []byte("## Some task"))
	if IsAllDone(dir) {
		t.Error("IsAllDone should be false when current.md doesn't contain ALL_DONE")
	}
}

func TestHasCurrentTask(t *testing.T) {
	dir := t.TempDir()

	// No file
	if HasCurrentTask(dir) {
		t.Error("HasCurrentTask should be false when current.md doesn't exist")
	}

	// Empty file
	writeTestFile(t, filepath.Join(dir, "current.md"), []byte(""))
	if HasCurrentTask(dir) {
		t.Error("HasCurrentTask should be false for empty current.md")
	}

	// Non-empty file
	writeTestFile(t, filepath.Join(dir, "current.md"), []byte("## Task"))
	if !HasCurrentTask(dir) {
		t.Error("HasCurrentTask should be true for non-empty current.md")
	}
}

func TestListCleanupFiles(t *testing.T) {
	dir := t.TempDir()

	// No files
	if files := ListCleanupFiles(dir); len(files) != 0 {
		t.Errorf("expected 0 cleanup files, got %d", len(files))
	}

	// Create some cleanup files
	writeTestFile(t, filepath.Join(dir, "cleanup-001.md"), []byte("a"))
	writeTestFile(t, filepath.Join(dir, "cleanup-002.md"), []byte("b"))
	writeTestFile(t, filepath.Join(dir, "current.md"), []byte("not cleanup"))

	files := ListCleanupFiles(dir)
	if len(files) != 2 {
		t.Errorf("expected 2 cleanup files, got %d", len(files))
	}
}

func TestListBreadcrumbs(t *testing.T) {
	dir := t.TempDir()

	writeTestFile(t, filepath.Join(dir, "current.md"), []byte("task"))
	writeTestFile(t, filepath.Join(dir, "cleanup-001.md"), []byte("fix"))

	breadcrumbs := ListBreadcrumbs(dir)
	if !strings.Contains(breadcrumbs, "current.md") {
		t.Error("breadcrumbs should contain current.md")
	}
	if !strings.Contains(breadcrumbs, "cleanup-001.md") {
		t.Error("breadcrumbs should contain cleanup-001.md")
	}
}
