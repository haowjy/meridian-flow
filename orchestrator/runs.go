package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// RunManifest stores metadata about a single orchestrator run.
type RunManifest struct {
	StartedAt       time.Time `json:"started_at"`
	PlanFile        string    `json:"plan_file"`
	AITool          string    `json:"ai_tool"`
	MaxSlices       int       `json:"max_slices"`
	SlicesCompleted int       `json:"slices_completed"`
	TotalCostUSD    float64   `json:"total_cost_usd"`
	Status          string    `json:"status"` // "running", "complete", "failed"
}

// RunSummary is a lightweight view of a run for listing.
type RunSummary struct {
	Dir      string      // directory name (timestamp)
	Path     string      // full path to run directory
	Manifest RunManifest // parsed manifest
}

// LogEntry holds key fields extracted from a Claude CLI JSON output file.
type LogEntry struct {
	DurationMS   float64 `json:"duration_ms"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	NumTurns     int     `json:"num_turns"`
	Result       string  `json:"result"`
}

// NewRunDir creates a timestamped subdirectory inside logsDir.
// Returns the path to the new directory.
func NewRunDir(logsDir string) (string, error) {
	ts := time.Now().Format("2006-01-02T15-04-05")
	dir := filepath.Join(logsDir, ts)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("creating run dir: %w", err)
	}
	return dir, nil
}

// WriteManifest writes or updates the manifest.json in a run directory.
func WriteManifest(runDir string, m *RunManifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling manifest: %w", err)
	}
	path := filepath.Join(runDir, "manifest.json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("writing manifest: %w", err)
	}
	return nil
}

// ReadManifest reads and parses manifest.json from a run directory.
func ReadManifest(runDir string) (*RunManifest, error) {
	data, err := os.ReadFile(filepath.Join(runDir, "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("reading manifest: %w", err)
	}
	var m RunManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parsing manifest: %w", err)
	}
	return &m, nil
}

// ListRuns scans logsDir for run subdirectories with manifest.json files.
// Returns runs sorted by start time (newest first).
func ListRuns(logsDir string) ([]RunSummary, error) {
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading logs dir: %w", err)
	}

	var runs []RunSummary
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(logsDir, e.Name())
		m, err := ReadManifest(dir)
		if err != nil {
			continue // skip dirs without valid manifests (e.g., old flat logs)
		}
		runs = append(runs, RunSummary{
			Dir:      e.Name(),
			Path:     dir,
			Manifest: *m,
		})
	}

	// Newest first
	sort.Slice(runs, func(i, j int) bool {
		return runs[i].Manifest.StartedAt.After(runs[j].Manifest.StartedAt)
	})

	return runs, nil
}

// ParseLogFile extracts key fields from a Claude CLI JSON output file.
// The file may contain a single JSON object or newline-delimited JSON.
// Extracts cost and duration from the last valid JSON object.
func ParseLogFile(path string) (*LogEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading log file: %w", err)
	}

	// Try parsing as a single JSON object first
	entry := &LogEntry{}
	if err := json.Unmarshal(data, entry); err == nil {
		// Truncate result for display
		if len(entry.Result) > 200 {
			entry.Result = entry.Result[:200] + "..."
		}
		return entry, nil
	}

	// Fall back to newline-delimited JSON — use the last valid object
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if err := json.Unmarshal([]byte(line), entry); err == nil {
			if len(entry.Result) > 200 {
				entry.Result = entry.Result[:200] + "..."
			}
			return entry, nil
		}
	}

	// Return an empty entry if we couldn't parse anything
	return &LogEntry{}, nil
}

// ListStageFiles returns log file names within a run directory,
// sorted alphabetically (slice-1-plan.json, slice-1-implement.json, etc.).
func ListStageFiles(runDir string) ([]string, error) {
	entries, err := os.ReadDir(runDir)
	if err != nil {
		return nil, fmt.Errorf("reading run dir: %w", err)
	}

	var files []string
	for _, e := range entries {
		if e.IsDir() || e.Name() == "manifest.json" {
			continue
		}
		if strings.HasSuffix(e.Name(), ".json") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	return files, nil
}
