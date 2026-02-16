package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

// UI is the output interface for the orchestrator.
// Two implementations: AnsiUI (default) and TuiUI (--tui flag).
type UI interface {
	Banner(plan, tool string, maxSlices int)
	SliceHeader(slice, maxSlices int)
	StageStart(name string)
	StageComplete(name string)
	AgentRunning(tool string, maxTurns int)
	AgentWarning(err error)
	Info(msg string)
	Warn(msg string)
	Done(logDir string)
	// AgentWriter returns an io.Writer for capturing agent output.
	// ANSI mode: returns os.Stdout (passthrough)
	// TUI mode: returns a writer that feeds the viewport
	AgentWriter() io.Writer
}

// ANSI color codes
const (
	reset   = "\033[0m"
	bold    = "\033[1m"
	dim     = "\033[2m"
	red     = "\033[31m"
	green   = "\033[32m"
	yellow  = "\033[33m"
	blue    = "\033[34m"
	magenta = "\033[35m"
	cyan    = "\033[36m"
	white   = "\033[37m"
)

// Stage colors for ANSI output
var stageColors = map[string]string{
	"plan":      blue,
	"implement": magenta,
	"review":    cyan,
	"cleanup":   yellow,
	"commit":    green,
}

// AnsiUI writes colored output to stderr.
type AnsiUI struct {
	w       io.Writer
	noColor bool
}

// NewAnsiUI creates an AnsiUI that writes to the given writer.
// Detects NO_COLOR env and whether the writer is a terminal.
func NewAnsiUI(w io.Writer) *AnsiUI {
	noColor := os.Getenv("NO_COLOR") != ""
	if !noColor {
		if f, ok := w.(*os.File); ok {
			noColor = !term.IsTerminal(int(f.Fd()))
		}
	}
	return &AnsiUI{w: w, noColor: noColor}
}

func (u *AnsiUI) color(c, text string) string {
	if u.noColor {
		return text
	}
	return c + text + reset
}

func (u *AnsiUI) Banner(plan, tool string, maxSlices int) {
	width := 50
	title := " Orchestrator "
	pad := (width - len(title) - 2) / 2

	fmt.Fprintf(u.w, "\n%s\n", u.color(dim, "┌"+strings.Repeat("─", pad)+title+strings.Repeat("─", width-pad-len(title)-2)+"┐"))
	fmt.Fprintf(u.w, "%s\n", u.color(dim, "│")+fmt.Sprintf("  Plan:   %s", u.color(bold, plan))+strings.Repeat(" ", max(0, width-12-len(plan)))+u.color(dim, "│"))
	fmt.Fprintf(u.w, "%s\n", u.color(dim, "│")+fmt.Sprintf("  Tool:   %s", u.color(cyan, tool))+strings.Repeat(" ", max(0, width-12-len(tool)))+u.color(dim, "│"))
	fmt.Fprintf(u.w, "%s\n", u.color(dim, "│")+fmt.Sprintf("  Slices: %d", maxSlices)+strings.Repeat(" ", max(0, width-12-len(fmt.Sprintf("%d", maxSlices))))+u.color(dim, "│"))
	fmt.Fprintf(u.w, "%s\n\n", u.color(dim, "└"+strings.Repeat("─", width-2)+"┘"))
}

func (u *AnsiUI) SliceHeader(slice, maxSlices int) {
	header := fmt.Sprintf(" Slice %d/%d ", slice, maxSlices)
	line := strings.Repeat("━", 20)
	fmt.Fprintf(u.w, "\n%s%s%s\n\n", u.color(bold, line), u.color(bold+white, header), u.color(bold, line))
}

func (u *AnsiUI) StageStart(name string) {
	c := stageColors[name]
	if c == "" {
		c = white
	}
	fmt.Fprintf(u.w, "  %s %s\n", u.color(c, "▶"), u.color(c+bold, name))
}

func (u *AnsiUI) StageComplete(name string) {
	fmt.Fprintf(u.w, "  %s %s\n", u.color(green, "✓"), u.color(dim, name))
}

func (u *AnsiUI) AgentRunning(tool string, maxTurns int) {
	fmt.Fprintf(u.w, "    %s %s (max %d turns)\n", u.color(dim, "→"), u.color(dim, tool), maxTurns)
}

func (u *AnsiUI) AgentWarning(err error) {
	fmt.Fprintf(u.w, "  %s %s\n", u.color(yellow, "⚠"), u.color(yellow, err.Error()))
}

func (u *AnsiUI) Info(msg string) {
	fmt.Fprintf(u.w, "  %s %s\n", u.color(dim, "·"), msg)
}

func (u *AnsiUI) Warn(msg string) {
	fmt.Fprintf(u.w, "  %s %s\n", u.color(yellow, "⚠"), u.color(yellow, msg))
}

func (u *AnsiUI) Done(logDir string) {
	fmt.Fprintf(u.w, "\n  %s %s\n", u.color(green, "✓"), u.color(green+bold, "Pipeline complete"))
	fmt.Fprintf(u.w, "    Logs: %s\n\n", u.color(dim, logDir))
}

func (u *AnsiUI) AgentWriter() io.Writer {
	return os.Stdout
}
