package main

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// --- TUI Messages (sent from orchestrator goroutine) ---

type stageStartMsg struct{ Name string }
type stageCompleteMsg struct{ Name string }
type agentOutputMsg struct{ Text string }
type sliceStartMsg struct{ Slice, MaxSlices int }
type pipelineDoneMsg struct{ Err error; RunDir string }

// --- Stage tracking ---

type StageStatus struct {
	Name      string
	Status    string // "pending" | "running" | "complete" | "warning"
	Duration  time.Duration
	StartedAt time.Time
}

// --- LiveModel: bubbletea model for live run ---

type LiveModel struct {
	// Pipeline state
	stages    []StageStatus
	slice     int
	maxSlices int
	tool      string
	planFile  string
	cost      float64

	// UI components
	viewport viewport.Model
	width    int
	height   int
	focus    int // 0=stages, 1=viewport

	// Communication
	events chan tea.Msg
	done   bool
	err    error
	runDir string

	// Agent output buffer
	outputLines []string
}

func newLiveModel(planFile, tool string, maxSlices int, events chan tea.Msg) LiveModel {
	vp := viewport.New(80, 20)
	vp.Style = lipgloss.NewStyle()

	return LiveModel{
		stages:    makeStageList(),
		planFile:  planFile,
		tool:      tool,
		maxSlices: maxSlices,
		viewport:  vp,
		events:    events,
	}
}

func makeStageList() []StageStatus {
	stages := make([]StageStatus, len(StageOrder))
	for i, name := range StageOrder {
		stages[i] = StageStatus{Name: name, Status: "pending"}
	}
	return stages
}

// waitForEvent returns a tea.Cmd that blocks on the events channel.
func (m LiveModel) waitForEvent() tea.Cmd {
	return func() tea.Msg {
		msg, ok := <-m.events
		if !ok {
			return pipelineDoneMsg{}
		}
		return msg
	}
}

func (m LiveModel) Init() tea.Cmd {
	return m.waitForEvent()
}

func (m LiveModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "tab":
			m.focus = (m.focus + 1) % 2
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		// Right panel takes remaining width
		rightWidth := m.width - stagePanelWidth - 4 // borders + padding
		if rightWidth < 20 {
			rightWidth = 20
		}
		vpHeight := m.height - 4 // borders + help line
		if vpHeight < 5 {
			vpHeight = 5
		}
		m.viewport.Width = rightWidth
		m.viewport.Height = vpHeight

	case sliceStartMsg:
		m.slice = msg.Slice
		m.maxSlices = msg.MaxSlices
		// Reset stages for new slice
		m.stages = makeStageList()
		cmds = append(cmds, m.waitForEvent())

	case stageStartMsg:
		for i := range m.stages {
			if m.stages[i].Name == msg.Name {
				m.stages[i].Status = "running"
				m.stages[i].StartedAt = time.Now()
				break
			}
		}
		cmds = append(cmds, m.waitForEvent())

	case stageCompleteMsg:
		for i := range m.stages {
			if m.stages[i].Name == msg.Name {
				m.stages[i].Status = "complete"
				if !m.stages[i].StartedAt.IsZero() {
					m.stages[i].Duration = time.Since(m.stages[i].StartedAt)
				}
				break
			}
		}
		cmds = append(cmds, m.waitForEvent())

	case agentOutputMsg:
		// Append new output and update viewport
		newLines := strings.Split(msg.Text, "\n")
		m.outputLines = append(m.outputLines, newLines...)
		// Keep a rolling buffer to prevent unbounded memory
		if len(m.outputLines) > 1000 {
			m.outputLines = m.outputLines[len(m.outputLines)-1000:]
		}
		m.viewport.SetContent(strings.Join(m.outputLines, "\n"))
		m.viewport.GotoBottom()
		cmds = append(cmds, m.waitForEvent())

	case pipelineDoneMsg:
		m.done = true
		m.err = msg.Err
		m.runDir = msg.RunDir
		// Don't quit automatically — let the user see the final state
		// They can press q to exit
	}

	// Handle viewport scrolling when focused
	if m.focus == 1 && !m.done {
		var vpCmd tea.Cmd
		m.viewport, vpCmd = m.viewport.Update(msg)
		cmds = append(cmds, vpCmd)
	}

	return m, tea.Batch(cmds...)
}

const stagePanelWidth = 26

func (m LiveModel) View() string {
	if m.width == 0 {
		return "Loading..."
	}

	// Left panel: stages
	leftContent := m.renderStages()
	leftStyle := PanelStyle(m.focus == 0, stagePanelWidth-2, m.height-4)
	leftPanel := leftStyle.Render(leftContent)

	// Right panel: agent output viewport
	rightWidth := m.width - stagePanelWidth - 2
	if rightWidth < 20 {
		rightWidth = 20
	}
	rightStyle := PanelStyle(m.focus == 1, rightWidth-2, m.height-4)

	// Title for right panel
	rightTitle := DimStyle.Render("─ Agent Output ")
	rightContent := m.viewport.View()
	rightPanel := rightStyle.Render(rightTitle + "\n" + rightContent)

	// Join panels
	panels := lipgloss.JoinHorizontal(lipgloss.Top, leftPanel, rightPanel)

	// Help line
	helpStyle := DimStyle
	help := helpStyle.Render("  q: quit  tab: focus  ↑↓: scroll")
	if m.done {
		if m.err != nil {
			help = RedStyle.Render("  Pipeline failed: "+m.err.Error()) + "  " + helpStyle.Render("q: quit")
		} else {
			help = GreenStyle.Render("  ✓ Pipeline complete") + "  " + helpStyle.Render("q: quit")
		}
	}

	return panels + "\n" + help
}

func (m LiveModel) renderStages() string {
	var b strings.Builder

	// Header
	b.WriteString(TitleStyle.Render("─ Stages") + "\n\n")

	for _, s := range m.stages {
		badge := StatusStyle(s.Status)
		name := s.Name

		// Color the name based on stage
		if c, ok := StageColorMap[s.Name]; ok && s.Status == "running" {
			name = lipgloss.NewStyle().Foreground(c).Bold(true).Render(name)
		} else if s.Status == "complete" {
			name = DimStyle.Render(name)
		}

		dur := ""
		if s.Status == "complete" && s.Duration > 0 {
			dur = DimStyle.Render(fmt.Sprintf(" %s", formatDuration(s.Duration)))
		} else if s.Status == "running" && !s.StartedAt.IsZero() {
			elapsed := time.Since(s.StartedAt)
			dur = DimStyle.Render(fmt.Sprintf(" %s", formatDuration(elapsed)))
		}

		b.WriteString(fmt.Sprintf("  %s %s%s\n", badge, name, dur))
	}

	// Footer info
	b.WriteString("\n")
	b.WriteString(DimStyle.Render(fmt.Sprintf("  Slice %d/%d\n", m.slice, m.maxSlices)))
	b.WriteString(DimStyle.Render(fmt.Sprintf("  Tool: %s\n", m.tool)))

	return b.String()
}

func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("0:%02d", int(d.Seconds()))
	}
	return fmt.Sprintf("%d:%02d", int(d.Minutes()), int(d.Seconds())%60)
}

// --- TuiUI: UI implementation that sends messages to bubbletea ---

type TuiUI struct {
	events chan tea.Msg
	writer *tuiWriter
}

func NewTuiUI(events chan tea.Msg) *TuiUI {
	return &TuiUI{
		events: events,
		writer: newTuiWriter(events),
	}
}

func (u *TuiUI) Banner(plan, tool string, maxSlices int) {
	// TUI displays this info in the stage panel, no separate banner needed
}

func (u *TuiUI) SliceHeader(slice, maxSlices int) {
	u.events <- sliceStartMsg{Slice: slice, MaxSlices: maxSlices}
}

func (u *TuiUI) StageStart(name string) {
	u.events <- stageStartMsg{Name: name}
}

func (u *TuiUI) StageComplete(name string) {
	u.events <- stageCompleteMsg{Name: name}
}

func (u *TuiUI) AgentRunning(tool string, maxTurns int) {
	// Shown in stage panel
}

func (u *TuiUI) AgentWarning(err error) {
	u.events <- agentOutputMsg{Text: fmt.Sprintf("⚠ %s", err.Error())}
}

func (u *TuiUI) Info(msg string) {
	u.events <- agentOutputMsg{Text: "· " + msg}
}

func (u *TuiUI) Warn(msg string) {
	u.events <- agentOutputMsg{Text: "⚠ " + msg}
}

func (u *TuiUI) Done(logDir string) {
	u.events <- pipelineDoneMsg{RunDir: logDir}
}

func (u *TuiUI) AgentWriter() io.Writer {
	return u.writer
}

// tuiWriter is an io.Writer that buffers lines and sends them to the TUI.
type tuiWriter struct {
	events chan tea.Msg
	mu     sync.Mutex
	buf    []byte
}

func newTuiWriter(events chan tea.Msg) *tuiWriter {
	return &tuiWriter{events: events}
}

func (w *tuiWriter) Write(p []byte) (n int, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.buf = append(w.buf, p...)

	// Send complete lines to the TUI
	for {
		idx := -1
		for i, b := range w.buf {
			if b == '\n' {
				idx = i
				break
			}
		}
		if idx < 0 {
			break
		}
		line := string(w.buf[:idx])
		w.buf = w.buf[idx+1:]
		w.events <- agentOutputMsg{Text: line}
	}

	return len(p), nil
}

// runWithTUI launches the bubbletea program and runs the orchestrator in a goroutine.
func runWithTUI(ctx *RunContext, startAt string, maxSlices int, quiet bool) error {
	events := make(chan tea.Msg, 100)

	// Create TUI-based UI and swap it into the context
	tuiUI := NewTuiUI(events)
	ctx.UI = tuiUI
	ctx.Agent.UI = tuiUI

	model := newLiveModel(ctx.PlanFile, ctx.Agent.Tool, maxSlices, events)

	// Run the orchestrator pipeline in a background goroutine
	var pipelineErr error
	go func() {
		pipelineErr = Run(ctx, startAt, maxSlices, quiet)
		if pipelineErr != nil {
			events <- pipelineDoneMsg{Err: pipelineErr, RunDir: ctx.RunDir}
		}
		close(events)
	}()

	// Run the TUI (blocks until user quits)
	p := tea.NewProgram(model, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("TUI error: %w", err)
	}

	return pipelineErr
}
