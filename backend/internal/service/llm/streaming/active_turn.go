package streaming

// ActiveTurnHandle abstracts StreamExecutor for transport-facing consumers.
type ActiveTurnHandle interface {
	RequestSoftCancel()
	RequestHardCancel()
	State() ExecutorState
	ThreadID() string
	TurnID() string
}

// ActiveTurnRegistry provides read access to active executor handles.
type ActiveTurnRegistry interface {
	GetByThread(threadID string) (ActiveTurnHandle, bool)
}

func (se *StreamExecutor) State() ExecutorState {
	return se.getState()
}

func (se *StreamExecutor) ThreadID() string {
	return se.threadID
}

func (se *StreamExecutor) TurnID() string {
	return se.turnID
}
