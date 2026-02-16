package main

import "github.com/charmbracelet/lipgloss"

// Colors
var (
	colorBlue    = lipgloss.Color("62")  // soft blue
	colorMagenta = lipgloss.Color("170") // magenta
	colorCyan    = lipgloss.Color("73")  // teal/cyan
	colorYellow  = lipgloss.Color("178") // amber
	colorGreen   = lipgloss.Color("78")  // green
	colorRed     = lipgloss.Color("196") // red
	colorDim     = lipgloss.Color("240") // gray
	colorWhite   = lipgloss.Color("252") // off-white
)

// StageColorMap maps stage names to their TUI colors.
var StageColorMap = map[string]lipgloss.Color{
	"plan":      colorBlue,
	"implement": colorMagenta,
	"review":    colorCyan,
	"cleanup":   colorYellow,
	"commit":    colorGreen,
}

// Status badges for stage progress
var StatusBadge = map[string]string{
	"complete": "✓",
	"running":  "▶",
	"pending":  "○",
	"skipped":  "−",
	"warning":  "⚠",
}

// Panel border styles
var (
	ActiveBorder = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorBlue)

	InactiveBorder = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorDim)
)

// Text styles
var (
	TitleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(colorWhite)

	DimStyle = lipgloss.NewStyle().
			Foreground(colorDim)

	GreenStyle = lipgloss.NewStyle().
			Foreground(colorGreen)

	YellowStyle = lipgloss.NewStyle().
			Foreground(colorYellow)

	RedStyle = lipgloss.NewStyle().
			Foreground(colorRed)

	BoldStyle = lipgloss.NewStyle().
			Bold(true)
)

// StatusStyle returns a styled status badge string.
func StatusStyle(status string) string {
	badge := StatusBadge[status]
	if badge == "" {
		badge = "?"
	}
	switch status {
	case "complete":
		return GreenStyle.Render(badge)
	case "running":
		return lipgloss.NewStyle().Foreground(colorBlue).Render(badge)
	case "warning":
		return YellowStyle.Render(badge)
	case "skipped":
		return DimStyle.Render(badge)
	default:
		return DimStyle.Render(badge)
	}
}

// PanelStyle returns a border style based on whether the panel is focused.
func PanelStyle(focused bool, width, height int) lipgloss.Style {
	style := InactiveBorder
	if focused {
		style = ActiveBorder
	}
	return style.Width(width).Height(height)
}
