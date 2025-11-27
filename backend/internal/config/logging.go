package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// SetupLogFile creates a new timestamped log file and cleans up old files.
// Returns the file handle (caller must close) or error.
func SetupLogFile(dir string, maxFiles int) (*os.File, error) {
	// Ensure directory exists
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}

	// Create timestamped log file
	filename := filepath.Join(dir, fmt.Sprintf("server-%s.log",
		time.Now().Format("2006-01-02T15-04-05")))

	f, err := os.Create(filename)
	if err != nil {
		return nil, fmt.Errorf("create log file: %w", err)
	}

	// Cleanup old files (keep maxFiles most recent)
	if err := cleanupOldLogs(dir, maxFiles); err != nil {
		// Log cleanup error but don't fail - logging still works
		fmt.Fprintf(os.Stderr, "warning: failed to cleanup old logs: %v\n", err)
	}

	return f, nil
}

// cleanupOldLogs removes oldest log files when count exceeds maxFiles.
func cleanupOldLogs(dir string, maxFiles int) error {
	pattern := filepath.Join(dir, "server-*.log")
	files, err := filepath.Glob(pattern)
	if err != nil {
		return err
	}

	if len(files) <= maxFiles {
		return nil
	}

	// Sort by name (timestamp format ensures chronological order)
	sort.Strings(files)

	// Remove oldest files
	for i := 0; i < len(files)-maxFiles; i++ {
		if err := os.Remove(files[i]); err != nil {
			return fmt.Errorf("remove %s: %w", files[i], err)
		}
	}

	return nil
}
