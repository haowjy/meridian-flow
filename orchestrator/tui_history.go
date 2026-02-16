package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// --- HistoryModel: three-panel browser for past runs ---

type HistoryModel struct {
	// Data
	runs      []RunSummary
	stages    []string // log file names for selected run
	logView   viewport.Model

	// Selection
	runIdx   int
	stageIdx int
	focus    int // 0=runs, 1=stages, 2=log

	// Layout
	width  int
	height int

	// State
	logsDir string
	err     error
}

func newHistoryModel(logsDir string) HistoryModel {
	vp := viewport.New(40, 20)
	return HistoryModel{
		logsDir: logsDir,
		logView: vp,
	}
}

func (m HistoryModel) Init() tea.Cmd {
	return func() tea.Msg {
		runs, err := ListRuns(m.logsDir)
		if err != nil {
			return historyErrorMsg{err}
		}
		return runsLoadedMsg{runs}
	}
}

type runsLoadedMsg struct{ runs []RunSummary }
type stagesLoadedMsg struct{ files []string }
type logLoadedMsg struct{ content string }
type historyErrorMsg struct{ err error }

func (m HistoryModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "tab":
			m.focus = (m.focus + 1) % 3
		case "shift+tab":
			m.focus = (m.focus + 2) % 3
		case "up", "k":
			m.moveUp()
			return m, m.loadSelection()
		case "down", "j":
			m.moveDown()
			return m, m.loadSelection()
		case "enter":
			// Move focus right on enter
			if m.focus < 2 {
				m.focus++
			}
			return m, m.loadSelection()
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.logView.Width = m.logPanelWidth() - 4
		m.logView.Height = m.height - 6

	case runsLoadedMsg:
		m.runs = msg.runs
		if len(m.runs) > 0 {
			return m, m.loadStagesForRun(0)
		}

	case stagesLoadedMsg:
		m.stages = msg.files
		m.stageIdx = 0
		if len(m.stages) > 0 {
			return m, m.loadLogFile(0)
		}

	case logLoadedMsg:
		m.logView.SetContent(msg.content)
		m.logView.GotoTop()

	case historyErrorMsg:
		m.err = msg.err
	}

	// Handle viewport scrolling when focused on log
	if m.focus == 2 {
		var vpCmd tea.Cmd
		m.logView, vpCmd = m.logView.Update(msg)
		return m, vpCmd
	}

	return m, nil
}

func (m *HistoryModel) moveUp() {
	switch m.focus {
	case 0:
		if m.runIdx > 0 {
			m.runIdx--
		}
	case 1:
		if m.stageIdx > 0 {
			m.stageIdx--
		}
	}
}

func (m *HistoryModel) moveDown() {
	switch m.focus {
	case 0:
		if m.runIdx < len(m.runs)-1 {
			m.runIdx++
		}
	case 1:
		if m.stageIdx < len(m.stages)-1 {
			m.stageIdx++
		}
	}
}

func (m HistoryModel) loadSelection() tea.Cmd {
	switch m.focus {
	case 0:
		return m.loadStagesForRun(m.runIdx)
	case 1:
		return m.loadLogFile(m.stageIdx)
	}
	return nil
}

func (m HistoryModel) loadStagesForRun(idx int) tea.Cmd {
	if idx >= len(m.runs) {
		return nil
	}
	run := m.runs[idx]
	return func() tea.Msg {
		files, err := ListStageFiles(run.Path)
		if err != nil {
			return historyErrorMsg{err}
		}
		return stagesLoadedMsg{files}
	}
}

func (m HistoryModel) loadLogFile(idx int) tea.Cmd {
	if m.runIdx >= len(m.runs) || idx >= len(m.stages) {
		return nil
	}
	run := m.runs[m.runIdx]
	file := m.stages[idx]
	return func() tea.Msg {
		path := filepath.Join(run.Path, file)
		entry, err := ParseLogFile(path)
		if err != nil {
			return logLoadedMsg{content: fmt.Sprintf("Error: %v", err)}
		}
		// Format for display
		var b strings.Builder
		fmt.Fprintf(&b, "File: %s\n\n", file)
		fmt.Fprintf(&b, "Duration: %.1fs\n", entry.DurationMS/1000)
		fmt.Fprintf(&b, "Cost:     $%.4f\n", entry.TotalCostUSD)
		fmt.Fprintf(&b, "Turns:    %d\n\n", entry.NumTurns)
		if entry.Result != "" {
			fmt.Fprintf(&b, "Result:\n%s\n", entry.Result)
		}
		return logLoadedMsg{content: b.String()}
	}
}

// Panel width calculations
const (
	runPanelWidth   = 28
	stagePanelWidthH = 22 // history stage panel (narrower than live)
)

func (m HistoryModel) logPanelWidth() int {
	w := m.width - runPanelWidth - stagePanelWidthH - 4
	if w < 20 {
		return 20
	}
	return w
}

func (m HistoryModel) View() string {
	if m.width == 0 {
		return "Loading..."
	}

	if m.err != nil {
		return RedStyle.Render(fmt.Sprintf("Error: %v", m.err))
	}

	if len(m.runs) == 0 {
		return DimStyle.Render("No runs found in " + m.logsDir + "\n\nPress q to quit.")
	}

	panelHeight := m.height - 4

	// Left panel: runs list
	leftContent := m.renderRuns()
	leftStyle := PanelStyle(m.focus == 0, runPanelWidth-2, panelHeight)
	leftPanel := leftStyle.Render(leftContent)

	// Middle panel: stages for selected run
	midContent := m.renderStages()
	midStyle := PanelStyle(m.focus == 1, stagePanelWidthH-2, panelHeight)
	midPanel := midStyle.Render(midContent)

	// Right panel: log viewer
	logWidth := m.logPanelWidth()
	rightStyle := PanelStyle(m.focus == 2, logWidth-2, panelHeight)
	rightPanel := rightStyle.Render(DimStyle.Render("─ Log ") + "\n" + m.logView.View())

	panels := lipgloss.JoinHorizontal(lipgloss.Top, leftPanel, midPanel, rightPanel)

	help := DimStyle.Render("  q: quit  tab: panel  ↑↓: navigate  enter: select")

	return panels + "\n" + help
}

func (m HistoryModel) renderRuns() string {
	var b strings.Builder
	b.WriteString(TitleStyle.Render("─ Runs") + "\n\n")

	for i, run := range m.runs {
		cursor := "  "
		if i == m.runIdx {
			cursor = lipgloss.NewStyle().Foreground(colorBlue).Render("▶ ")
		}

		// Format time
		t := run.Manifest.StartedAt.Format("Jan 02, 15:04")

		// Status badge
		var statusIcon string
		switch run.Manifest.Status {
		case "complete":
			statusIcon = GreenStyle.Render("✓")
		case "failed":
			statusIcon = RedStyle.Render("✗")
		case "running":
			statusIcon = lipgloss.NewStyle().Foreground(colorBlue).Render("▶")
		default:
			statusIcon = DimStyle.Render("?")
		}

		nameStyle := lipgloss.NewStyle()
		if i == m.runIdx {
			nameStyle = nameStyle.Bold(true)
		}

		b.WriteString(fmt.Sprintf("%s%s %s\n", cursor, statusIcon, nameStyle.Render(t)))

		// Plan file (truncated)
		plan := run.Manifest.PlanFile
		if len(plan) > 22 {
			plan = "…" + plan[len(plan)-21:]
		}
		b.WriteString(fmt.Sprintf("    %s\n", DimStyle.Render(plan)))

		// Stats
		stats := fmt.Sprintf("%d slices · $%.2f", run.Manifest.SlicesCompleted, run.Manifest.TotalCostUSD)
		b.WriteString(fmt.Sprintf("    %s\n\n", DimStyle.Render(stats)))
	}

	return b.String()
}

func (m HistoryModel) renderStages() string {
	var b strings.Builder
	b.WriteString(TitleStyle.Render("─ Stages") + "\n\n")

	if len(m.stages) == 0 {
		b.WriteString(DimStyle.Render("  (no logs)"))
		return b.String()
	}

	for i, file := range m.stages {
		cursor := "  "
		if i == m.stageIdx && m.focus >= 1 {
			cursor = lipgloss.NewStyle().Foreground(colorBlue).Render("▶ ")
		}

		// Extract stage name from filename (e.g., "slice-1-plan.json" → "plan")
		name := file
		name = strings.TrimSuffix(name, ".json")

		style := DimStyle
		if i == m.stageIdx {
			style = lipgloss.NewStyle()
		}

		b.WriteString(fmt.Sprintf("%s%s\n", cursor, style.Render(name)))
	}

	return b.String()
}

// runHistory launches the history TUI.
func runHistory(logsDir string) error {
	model := newHistoryModel(logsDir)
	p := tea.NewProgram(model, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("history TUI error: %w", err)
	}
	return nil
}
