package llm

// TurnRepository defines the full interface for turn data access
// Composed of focused interfaces for better separation of concerns (ISP compliance)
// Components should depend on the minimal interface they need (TurnWriter, TurnReader, or TurnNavigator)
// This composite interface is for components that need full access
type TurnRepository interface {
	TurnWriter
	TurnReader
	TurnNavigator
}
