package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RotateTasks moves current.md content into progress.md (append) and
// removes current.md + cleanup-*.md files. This prepares the tasks
// directory for the next slice.
func RotateTasks(tasksDir string) error {
	currentPath := filepath.Join(tasksDir, "current.md")
	progressPath := filepath.Join(tasksDir, "progress.md")

	// Append current.md to progress.md (if it exists)
	currentContent, err := os.ReadFile(currentPath)
	if err == nil && len(currentContent) > 0 {
		f, err := os.OpenFile(progressPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			return fmt.Errorf("opening progress.md: %w", err)
		}
		defer func() { _ = f.Close() }()

		if _, err := f.Write(currentContent); err != nil {
			return fmt.Errorf("appending to progress.md: %w", err)
		}
		if _, err := f.WriteString("\n---\n\n"); err != nil {
			return fmt.Errorf("writing separator to progress.md: %w", err)
		}
	}

	// Remove current.md (best-effort, may not exist)
	_ = os.Remove(currentPath)

	// Remove cleanup-*.md files (best-effort)
	cleanupFiles, _ := filepath.Glob(filepath.Join(tasksDir, "cleanup-*.md"))
	for _, f := range cleanupFiles {
		_ = os.Remove(f)
	}

	return nil
}

// CleanupProgress removes the progress.md file (called at pipeline end).
func CleanupProgress(tasksDir string) {
	_ = os.Remove(filepath.Join(tasksDir, "progress.md"))
}

// ListCleanupFiles returns paths to all cleanup-*.md files in the tasks dir.
func ListCleanupFiles(tasksDir string) []string {
	files, _ := filepath.Glob(filepath.Join(tasksDir, "cleanup-*.md"))
	return files
}

// ListBreadcrumbs returns a formatted string of all .md files in the tasks dir,
// used by the commit stage for context.
func ListBreadcrumbs(tasksDir string) string {
	files, _ := filepath.Glob(filepath.Join(tasksDir, "*.md"))
	var result string
	for _, f := range files {
		result += "\n- " + f
	}
	return result
}

// IsAllDone checks if current.md contains "ALL_DONE".
func IsAllDone(tasksDir string) bool {
	content, err := os.ReadFile(filepath.Join(tasksDir, "current.md"))
	if err != nil {
		return false
	}
	return containsAllDone(string(content))
}

// HasCurrentTask checks if current.md exists and is non-empty.
func HasCurrentTask(tasksDir string) bool {
	info, err := os.Stat(filepath.Join(tasksDir, "current.md"))
	if err != nil {
		return false
	}
	return info.Size() > 0
}

// containsAllDone checks if a string contains the ALL_DONE marker.
func containsAllDone(s string) bool {
	return strings.Contains(s, "ALL_DONE")
}
