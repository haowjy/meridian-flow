package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
)

// Agent wraps an AI CLI tool (claude, codex, opencode) and handles
// command construction, prompt passing, and output streaming.
type Agent struct {
	Tool string // "claude", "codex", or "opencode"
	UI   UI
}

// NewAgent creates an Agent for the specified AI tool.
func NewAgent(tool string, ui UI) (*Agent, error) {
	switch tool {
	case "claude", "codex", "opencode":
		return &Agent{Tool: tool, UI: ui}, nil
	default:
		return nil, fmt.Errorf("unknown AI tool: %q (expected claude, codex, or opencode)", tool)
	}
}

// Run executes the AI agent with the given prompt and configuration.
// Output is tee'd to both the logWriter and the UI's AgentWriter (unless quiet).
func (a *Agent) Run(prompt, contextFile, tools string, maxTurns int, logWriter io.Writer, quiet bool) error {
	// Write prompt to temp file to avoid ARG_MAX limits
	promptFile, err := os.CreateTemp("", "orchestrator-prompt-*.md")
	if err != nil {
		return fmt.Errorf("creating temp prompt file: %w", err)
	}
	defer func() { _ = os.Remove(promptFile.Name()) }()

	if _, err := promptFile.WriteString(prompt); err != nil {
		_ = promptFile.Close()
		return fmt.Errorf("writing prompt to temp file: %w", err)
	}
	if err := promptFile.Close(); err != nil {
		return fmt.Errorf("closing temp prompt file: %w", err)
	}

	cmd, stdinFile, err := a.buildCommand(promptFile.Name(), contextFile, tools, maxTurns)
	if err != nil {
		return err
	}
	if stdinFile != nil {
		defer stdinFile.Close()
	}

	// Tee output: always write to log, optionally stream to UI's writer
	if quiet {
		cmd.Stdout = logWriter
		cmd.Stderr = logWriter
	} else {
		agentW := a.UI.AgentWriter()
		cmd.Stdout = io.MultiWriter(agentW, logWriter)
		cmd.Stderr = io.MultiWriter(agentW, logWriter)
	}

	a.UI.AgentRunning(a.Tool, maxTurns)

	if err := cmd.Run(); err != nil {
		// Log but don't fail — matches the `|| true` behavior from run.sh.
		// Agent failures (e.g., LLM timeout) shouldn't stop the pipeline.
		a.UI.AgentWarning(err)
		return nil
	}

	return nil
}

// buildCommand constructs the exec.Cmd for the configured AI tool.
// Returns the command and an optional stdin file that the caller must close.
func (a *Agent) buildCommand(promptFile, contextFile, tools string, maxTurns int) (*exec.Cmd, *os.File, error) {
	switch a.Tool {
	case "claude":
		return a.buildClaudeCmd(promptFile, contextFile, tools, maxTurns)
	case "codex":
		return a.buildCodexCmd(promptFile)
	case "opencode":
		return a.buildOpenCodeCmd(promptFile)
	default:
		return nil, nil, fmt.Errorf("unknown AI tool: %s", a.Tool)
	}
}

// buildClaudeCmd: claude -p - --output-format json --max-turns N --allowedTools T [--append-system-prompt-file F]
// Returns the stdin file so the caller can close it after cmd.Run().
func (a *Agent) buildClaudeCmd(promptFile, contextFile, tools string, maxTurns int) (*exec.Cmd, *os.File, error) {
	args := []string{
		"-p", "-",
		"--output-format", "json",
		"--max-turns", fmt.Sprintf("%d", maxTurns),
		"--allowedTools", tools,
	}
	if contextFile != "" {
		args = append(args, "--append-system-prompt-file", contextFile)
	}

	cmd := exec.Command("claude", args...)

	// Pipe prompt via stdin (claude -p - reads from stdin)
	stdin, err := os.Open(promptFile)
	if err != nil {
		return nil, nil, fmt.Errorf("opening prompt file for stdin: %w", err)
	}
	cmd.Stdin = stdin
	return cmd, stdin, nil
}

// buildCodexCmd: codex exec - --json (reads prompt from stdin, auto-discovers AGENTS.md)
func (a *Agent) buildCodexCmd(promptFile string) (*exec.Cmd, *os.File, error) {
	cmd := exec.Command("codex", "exec", "-", "--json")

	stdin, err := os.Open(promptFile)
	if err != nil {
		return nil, nil, fmt.Errorf("opening prompt file for stdin: %w", err)
	}
	cmd.Stdin = stdin
	return cmd, stdin, nil
}

// buildOpenCodeCmd: opencode -p - -f json -q (reads prompt from stdin, auto-discovers AGENTS.md)
func (a *Agent) buildOpenCodeCmd(promptFile string) (*exec.Cmd, *os.File, error) {
	cmd := exec.Command("opencode", "-p", "-", "-f", "json", "-q")

	stdin, err := os.Open(promptFile)
	if err != nil {
		return nil, nil, fmt.Errorf("opening prompt file for stdin: %w", err)
	}
	cmd.Stdin = stdin
	return cmd, stdin, nil
}
