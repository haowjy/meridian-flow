package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	// Subcommand: "history" launches the history browser TUI
	if len(os.Args) > 1 && os.Args[1] == "history" {
		historyCmd(os.Args[2:])
		return
	}

	// Default: "run" subcommand (backward compatible with positional plan file)
	runCmd()
}

func runCmd() {
	// CLI flags
	startAt := flag.String("start-at", "", "Stage to start from: plan|implement|review|cleanup|commit")
	maxSlices := flag.Int("max-slices", 20, "Maximum number of slices to process")
	quiet := flag.Bool("quiet", false, "Suppress LLM output streaming (logs only)")
	aiTool := flag.String("ai-tool", "", "AI tool: claude|codex|opencode (default: $AI_TOOL or codex)")
	tui := flag.Bool("tui", false, "Launch live TUI with split view")
	flag.Parse()

	// Plan file: first positional arg (skip "run" if present)
	args := flag.Args()
	planFile := ""
	if len(args) > 0 {
		if args[0] == "run" && len(args) > 1 {
			planFile = args[1]
		} else {
			planFile = args[0]
		}
	}

	if planFile == "" {
		fmt.Fprintln(os.Stderr, "Usage: orchestrator [flags] <plan-file>")
		fmt.Fprintln(os.Stderr, "       orchestrator run [flags] <plan-file>")
		fmt.Fprintln(os.Stderr, "       orchestrator history [--logs-dir]")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Flags:")
		flag.PrintDefaults()
		os.Exit(1)
	}

	// Validate --start-at
	if *startAt != "" && !ValidStage(*startAt) {
		log.Fatalf("invalid --start-at %q, valid stages: %s", *startAt, ValidStageNames())
	}

	// Resolve AI tool: flag > env > default
	tool := *aiTool
	if tool == "" {
		tool = os.Getenv("AI_TOOL")
	}
	if tool == "" {
		tool = "codex"
	}

	// Resolve repo root via git
	repoRoot, err := resolveRepoRoot()
	if err != nil {
		log.Fatalf("failed to resolve repo root: %v", err)
	}

	// Create UI
	ui := NewAnsiUI(os.Stderr)

	// Create agent
	agent, err := NewAgent(tool, ui)
	if err != nil {
		log.Fatalf("failed to create agent: %v", err)
	}

	// Build run context
	ctx := &RunContext{
		PlanFile:   planFile,
		TasksDir:   filepath.Join(repoRoot, "_docs", "hidden", "tasks"),
		LogDir:     filepath.Join(repoRoot, "_docs", "hidden", "orchestrator-logs"),
		PromptsDir: filepath.Join(repoRoot, "scripts", "orchestrator", "prompts"),
		RepoRoot:   repoRoot,
		Agent:      agent,
		UI:         ui,
	}

	// TUI mode: launch bubbletea with orchestrator in background goroutine
	if *tui {
		if err := runWithTUI(ctx, *startAt, *maxSlices, *quiet); err != nil {
			log.Fatalf("orchestrator failed: %v", err)
		}
		return
	}

	// ANSI mode: run directly
	if err := Run(ctx, *startAt, *maxSlices, *quiet); err != nil {
		log.Fatalf("orchestrator failed: %v", err)
	}
}

func historyCmd(args []string) {
	fs := flag.NewFlagSet("history", flag.ExitOnError)
	logsDir := fs.String("logs-dir", "", "Override logs directory")
	_ = fs.Parse(args)

	dir := *logsDir
	if dir == "" {
		repoRoot, err := resolveRepoRoot()
		if err != nil {
			log.Fatalf("failed to resolve repo root: %v", err)
		}
		dir = filepath.Join(repoRoot, "_docs", "hidden", "orchestrator-logs")
	}

	if err := runHistory(dir); err != nil {
		log.Fatalf("history failed: %v", err)
	}
}

// resolveRepoRoot uses `git rev-parse --show-toplevel` to find the repo root.
func resolveRepoRoot() (string, error) {
	cmd := exec.Command("git", "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git rev-parse --show-toplevel: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}
