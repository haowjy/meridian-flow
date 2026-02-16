package main

import "fmt"

// Stage defines a single orchestrator stage with its configuration.
// Adding a new stage = add to Stages map + StageOrder slice (OCP).
type Stage struct {
	Name     string
	Template string // prompt template filename in prompts/ dir
	Tools    string // comma-separated allowed tools for the AI agent
	MaxTurns int
	// RenderVars returns template variables for this stage.
	// The RunContext provides access to plan file, tasks dir, etc.
	RenderVars func(ctx *RunContext) (map[string]string, error)
}

// StageOrder defines the execution order of stages within each slice.
var StageOrder = []string{"plan", "implement", "review", "cleanup", "commit"}

// Stages maps stage names to their configuration.
var Stages = map[string]*Stage{
	"plan": {
		Name:     "plan",
		Template: "plan-slice.md",
		Tools:    "Read,Edit,Write,Glob,Grep",
		MaxTurns: 10,
		RenderVars: func(ctx *RunContext) (map[string]string, error) {
			return map[string]string{
				"PLAN_FILE": ctx.PlanFile,
				"TASKS_DIR": ctx.TasksDir,
			}, nil
		},
	},
	"implement": {
		Name:     "implement",
		Template: "implement.md",
		Tools:    "Read,Edit,Write,Bash,Glob,Grep",
		MaxTurns: 25,
		RenderVars: func(ctx *RunContext) (map[string]string, error) {
			return map[string]string{
				"TASKS_DIR": ctx.TasksDir,
			}, nil
		},
	},
	"review": {
		Name:     "review",
		Template: "review.md",
		Tools:    "Read,Edit,Write,Bash,Glob,Grep",
		MaxTurns: 15,
		RenderVars: func(ctx *RunContext) (map[string]string, error) {
			return map[string]string{
				"TASKS_DIR": ctx.TasksDir,
			}, nil
		},
	},
	"cleanup": {
		Name:     "cleanup",
		Template: "cleanup.md",
		Tools:    "Read,Edit,Write,Bash,Glob,Grep",
		MaxTurns: 10,
		// RenderVars is handled per-file in the cleanup loop (needs CLEANUP_FILE)
		RenderVars: nil,
	},
	"commit": {
		Name:     "commit",
		Template: "commit.md",
		Tools:    "Bash,Read,Glob,Grep",
		MaxTurns: 5,
		// RenderVars needs dynamic breadcrumbs — handled in orchestrator loop
		RenderVars: nil,
	},
}

// ValidStage returns true if the given name is a known stage.
func ValidStage(name string) bool {
	_, ok := Stages[name]
	return ok
}

// StageIndex returns the index of a stage in StageOrder, or -1 if not found.
func StageIndex(name string) int {
	for i, s := range StageOrder {
		if s == name {
			return i
		}
	}
	return -1
}

// ValidStageNames returns a formatted string of valid stage names for error messages.
func ValidStageNames() string {
	return fmt.Sprintf("%v", StageOrder)
}
