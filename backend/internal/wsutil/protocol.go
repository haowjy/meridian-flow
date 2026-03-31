package wsutil

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	KindControl = "control"
	KindNotify  = "notify"
	KindStream  = "stream"
	KindError   = "error"
)

const (
	OpAuth         = "auth"
	OpConnected    = "connected"
	OpPing         = "ping"
	OpPong         = "pong"
	OpSubscribe    = "subscribe"
	OpSubscribed   = "subscribed"
	OpUnsubscribe  = "unsubscribe"
	OpUnsubscribed = "unsubscribed"
	OpEvent        = "event"
	OpEnded        = "ended"
	OpGap          = "gap"
	OpMessage      = "message"
	OpInvalidate   = "invalidate"
	OpError        = "error"
)

const (
	CodeSubscribeFailed = "SUBSCRIBE_FAILED"
	CodeRateLimited     = "RATE_LIMITED"
	CodeAuthFailed      = "AUTH_FAILED"
	CodeInvalidMessage  = "INVALID_MESSAGE"
	CodeNotSupported    = "NOT_SUPPORTED"
)

// Envelope is the generic wire message.
type Envelope struct {
	Kind     string          `json:"kind"`
	Op       string          `json:"op"`
	Resource *Resource       `json:"resource,omitempty"`
	SubId    string          `json:"subId,omitempty"`
	Seq      int64           `json:"seq,omitempty"`
	Epoch    string          `json:"epoch,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

// Resource identifies a target resource.
type Resource struct {
	Type string `json:"type"`
	Id   string `json:"id"`
}

// ErrorPayload is sent inside error envelopes.
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

var validKinds = map[string]struct{}{
	KindControl: {},
	KindNotify:  {},
	KindStream:  {},
	KindError:   {},
}

// Validate checks envelope shape required by the generic protocol.
func (e *Envelope) Validate() error {
	if e == nil {
		return errors.New("envelope is nil")
	}

	kind := strings.TrimSpace(e.Kind)
	if kind == "" {
		return errors.New("kind is required")
	}
	if _, ok := validKinds[kind]; !ok {
		return fmt.Errorf("unknown kind %q", e.Kind)
	}
	if strings.TrimSpace(e.Op) == "" {
		return errors.New("op is required")
	}

	return nil
}

// ParseEnvelope decodes and validates a JSON envelope.
func ParseEnvelope(data []byte) (*Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("unmarshal envelope: %w", err)
	}
	if err := env.Validate(); err != nil {
		return nil, err
	}
	return &env, nil
}

// NewErrorEnvelope returns a connection-scoped error envelope.
func NewErrorEnvelope(code, message string) Envelope {
	payload, _ := json.Marshal(ErrorPayload{Code: code, Message: message})
	return Envelope{
		Kind:    KindError,
		Op:      OpError,
		Payload: payload,
	}
}

// NewSubErrorEnvelope returns an error envelope for a specific subscription/resource.
func NewSubErrorEnvelope(subID string, resource *Resource, code, message string) Envelope {
	env := NewErrorEnvelope(code, message)
	env.SubId = subID
	env.Resource = resource
	return env
}

// ParseErrorPayload unmarshals the common error payload.
func ParseErrorPayload(raw json.RawMessage) (ErrorPayload, error) {
	var p ErrorPayload
	if len(raw) == 0 {
		return p, errors.New("empty error payload")
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, err
	}
	return p, nil
}
