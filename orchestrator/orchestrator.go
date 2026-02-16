package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// RunContext holds all paths and dependencies needed by the orchestrator loop.
type RunContext struct {
	PlanFile   string
	TasksDir   string
	LogDir     string // parent logs directory
	RunDir     string // per-run log subdirectory (timestamped)
	PromptsDir string
	RepoRoot   string
	Agent      *Agent
	UI         UI
}

// Run executes the orchestrator pipeline: iterate slices, run stages.
// startAt optionally skips stages on the first slice (e.g., --start-at implement).
// maxSlices caps the total number of slice iterations.
// quiet suppresses LLM output streaming to the terminal.
func Run(ctx *RunContext, startAt string, maxSlices int, quiet bool) error {
	startIdx := 0
	if startAt != "" {
		startIdx = StageIndex(startAt)
		if startIdx < 0 {
			return fmt.Errorf("unknown stage %q, valid stages: %s", startAt, ValidStageNames())
		}
	}

	// Ensure output directories exist
	if err := os.MkdirAll(ctx.TasksDir, 0755); err != nil {
		return fmt.Errorf("creating tasks dir: %w", err)
	}
	if err := os.MkdirAll(ctx.LogDir, 0755); err != nil {
		return fmt.Errorf("creating log dir: %w", err)
	}

	// Create per-run directory
	runDir, err := NewRunDir(ctx.LogDir)
	if err != nil {
		return fmt.Errorf("creating run dir: %w", err)
	}
	ctx.RunDir = runDir

	// Write initial manifest
	manifest := &RunManifest{
		StartedAt: time.Now(),
		PlanFile:  ctx.PlanFile,
		AITool:    ctx.Agent.Tool,
		MaxSlices: maxSlices,
		Status:    "running",
	}
	if err := WriteManifest(ctx.RunDir, manifest); err != nil {
		return fmt.Errorf("writing initial manifest: %w", err)
	}

	ctx.UI.Banner(ctx.PlanFile, ctx.Agent.Tool, maxSlices)

	var totalCost float64
	var slicesCompleted int

	for slice := 1; slice <= maxSlices; slice++ {
		ctx.UI.SliceHeader(slice, maxSlices)

		for i, name := range StageOrder {
			// --start-at: skip earlier stages on the first slice only
			if slice == 1 && i < startIdx {
				continue
			}

			// Cleanup is a sub-loop over cleanup-*.md files
			if name == "cleanup" {
				if err := runCleanupStages(ctx, slice, quiet); err != nil {
					manifest.Status = "failed"
					manifest.SlicesCompleted = slicesCompleted
					manifest.TotalCostUSD = totalCost
					_ = WriteManifest(ctx.RunDir, manifest)
					return err
				}
				continue
			}

			// Commit needs dynamic breadcrumbs
			if name == "commit" {
				if err := runCommitStage(ctx, slice, quiet); err != nil {
					manifest.Status = "failed"
					manifest.SlicesCompleted = slicesCompleted
					manifest.TotalCostUSD = totalCost
					_ = WriteManifest(ctx.RunDir, manifest)
					return err
				}

				// Accumulate cost from commit log
				totalCost += parseStageCost(ctx.RunDir, slice, "commit")

				// Rotate task files after commit
				ctx.UI.Info("rotating task files")
				if err := RotateTasks(ctx.TasksDir); err != nil {
					return fmt.Errorf("rotating tasks: %w", err)
				}
				slicesCompleted = slice
				continue
			}

			// Standard stage (plan, implement, review)
			stage := Stages[name]
			if err := runStage(ctx, stage, slice, quiet); err != nil {
				manifest.Status = "failed"
				manifest.SlicesCompleted = slicesCompleted
				manifest.TotalCostUSD = totalCost
				_ = WriteManifest(ctx.RunDir, manifest)
				return err
			}

			// Accumulate cost
			totalCost += parseStageCost(ctx.RunDir, slice, name)

			// Post-plan checks
			if name == "plan" {
				if IsAllDone(ctx.TasksDir) {
					ctx.UI.Info("all slices complete")
					CleanupProgress(ctx.TasksDir)

					manifest.Status = "complete"
					manifest.SlicesCompleted = slicesCompleted
					manifest.TotalCostUSD = totalCost
					_ = WriteManifest(ctx.RunDir, manifest)

					ctx.UI.Done(ctx.RunDir)
					return nil
				}
				if !HasCurrentTask(ctx.TasksDir) {
					ctx.UI.Warn(fmt.Sprintf("no current.md produced — skipping to next slice (slice %d)", slice))
					break // skip implement/review/cleanup/commit, go to next slice
				}
			}
		}
	}

	// Final cleanup
	CleanupProgress(ctx.TasksDir)

	manifest.Status = "complete"
	manifest.SlicesCompleted = slicesCompleted
	manifest.TotalCostUSD = totalCost
	_ = WriteManifest(ctx.RunDir, manifest)

	ctx.UI.Done(ctx.RunDir)
	return nil
}

// runStage renders a template and runs the AI agent for a standard stage.
func runStage(ctx *RunContext, stage *Stage, slice int, quiet bool) error {
	ctx.UI.StageStart(stage.Name)

	var vars map[string]string
	if stage.RenderVars != nil {
		var err error
		vars, err = stage.RenderVars(ctx)
		if err != nil {
			return fmt.Errorf("getting render vars for %s: %w", stage.Name, err)
		}
	}

	prompt, err := RenderTemplate(ctx.PromptsDir, stage.Template, vars)
	if err != nil {
		return fmt.Errorf("rendering template for %s: %w", stage.Name, err)
	}

	logFile, err := openLogFile(ctx.RunDir, slice, stage.Name)
	if err != nil {
		return err
	}
	defer func() { _ = logFile.Close() }()

	contextFile := filepath.Join(ctx.RepoRoot, "CLAUDE.md")
	if err := ctx.Agent.Run(prompt, contextFile, stage.Tools, stage.MaxTurns, logFile, quiet); err != nil {
		return err
	}

	ctx.UI.StageComplete(stage.Name)
	return nil
}

// runCleanupStages iterates over cleanup-*.md files and runs the cleanup agent on each.
func runCleanupStages(ctx *RunContext, slice int, quiet bool) error {
	cleanupFiles := ListCleanupFiles(ctx.TasksDir)
	if len(cleanupFiles) == 0 {
		ctx.UI.Info("no cleanup tasks found")
		return nil
	}

	stage := Stages["cleanup"]
	for _, cleanupFile := range cleanupFiles {
		baseName := filepath.Base(cleanupFile)
		ctx.UI.StageStart("cleanup: " + baseName)

		vars := map[string]string{
			"CLEANUP_FILE": cleanupFile,
		}

		prompt, err := RenderTemplate(ctx.PromptsDir, stage.Template, vars)
		if err != nil {
			return fmt.Errorf("rendering cleanup template: %w", err)
		}

		logName := baseName[:len(baseName)-3] // strip .md
		logFile, err := openLogFile(ctx.RunDir, slice, logName)
		if err != nil {
			return err
		}

		contextFile := filepath.Join(ctx.RepoRoot, "CLAUDE.md")
		if err := ctx.Agent.Run(prompt, contextFile, stage.Tools, stage.MaxTurns, logFile, quiet); err != nil {
			_ = logFile.Close()
			return err
		}
		_ = logFile.Close()

		ctx.UI.StageComplete("cleanup: " + baseName)
	}

	return nil
}

// runCommitStage builds breadcrumbs from task files and runs the commit agent.
func runCommitStage(ctx *RunContext, slice int, quiet bool) error {
	ctx.UI.StageStart("commit")

	stage := Stages["commit"]
	breadcrumbs := ListBreadcrumbs(ctx.TasksDir)

	vars := map[string]string{
		"BREADCRUMBS": breadcrumbs,
	}

	prompt, err := RenderTemplate(ctx.PromptsDir, stage.Template, vars)
	if err != nil {
		return fmt.Errorf("rendering commit template: %w", err)
	}

	logFile, err := openLogFile(ctx.RunDir, slice, "commit")
	if err != nil {
		return err
	}
	defer func() { _ = logFile.Close() }()

	contextFile := filepath.Join(ctx.RepoRoot, "CLAUDE.md")
	if err := ctx.Agent.Run(prompt, contextFile, stage.Tools, stage.MaxTurns, logFile, quiet); err != nil {
		return err
	}

	ctx.UI.StageComplete("commit")
	return nil
}

// openLogFile creates a log file for a given slice and stage.
func openLogFile(logDir string, slice int, stageName string) (*os.File, error) {
	name := filepath.Join(logDir, fmt.Sprintf("slice-%d-%s.json", slice, stageName))
	f, err := os.Create(name)
	if err != nil {
		return nil, fmt.Errorf("creating log file %s: %w", name, err)
	}
	return f, nil
}

// parseStageCost extracts the cost from a stage log file.
// Returns 0 if the file can't be parsed.
func parseStageCost(runDir string, slice int, stageName string) float64 {
	path := filepath.Join(runDir, fmt.Sprintf("slice-%d-%s.json", slice, stageName))
	entry, err := ParseLogFile(path)
	if err != nil {
		return 0
	}
	return entry.TotalCostUSD
}
