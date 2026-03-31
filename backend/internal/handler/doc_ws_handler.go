package handler

import (
	"log/slog"

	"meridian/internal/wsutil"
)

var _ wsutil.Handler = (*DocNotifyHandler)(nil)

// DocNotifyHandler handles project-scoped doc websocket connections.
type DocNotifyHandler struct {
	logger *slog.Logger
}

type docNotifyState struct {
	session wsutil.Session
}

func NewDocNotifyHandler(logger *slog.Logger) *DocNotifyHandler {
	if logger == nil {
		logger = slog.Default()
	}

	return &DocNotifyHandler{logger: logger}
}

func (h *DocNotifyHandler) OnConnect(session wsutil.Session) (wsutil.State, error) {
	return &docNotifyState{session: session}, nil
}

func (h *DocNotifyHandler) OnSubscribe(state wsutil.State, sub wsutil.SubscribeRequest) error {
	return wsutil.ErrNotSupported
}

func (h *DocNotifyHandler) OnUnsubscribe(state wsutil.State, subID string) error {
	return wsutil.ErrNotSupported
}

func (h *DocNotifyHandler) OnMessage(state wsutil.State, msg wsutil.Envelope) error {
	return wsutil.ErrNotSupported
}

func (h *DocNotifyHandler) OnDisconnect(state wsutil.State) {}
