package wsutil

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseEnvelope_Valid(t *testing.T) {
	env, err := ParseEnvelope([]byte(`{"kind":"control","op":"ping"}`))
	if err != nil {
		t.Fatalf("ParseEnvelope returned error: %v", err)
	}
	if env.Kind != KindControl || env.Op != OpPing {
		t.Fatalf("unexpected envelope: %+v", env)
	}
}

func TestParseEnvelope_InvalidJSON(t *testing.T) {
	if _, err := ParseEnvelope([]byte(`{"kind":`)); err == nil {
		t.Fatal("expected parse error for invalid json")
	}
}

func TestParseEnvelope_MissingKind(t *testing.T) {
	_, err := ParseEnvelope([]byte(`{"op":"ping"}`))
	if err == nil {
		t.Fatal("expected error for missing kind")
	}
	if !strings.Contains(err.Error(), "kind") {
		t.Fatalf("expected kind error, got: %v", err)
	}
}

func TestParseEnvelope_UnknownKind(t *testing.T) {
	_, err := ParseEnvelope([]byte(`{"kind":"unknown","op":"x"}`))
	if err == nil {
		t.Fatal("expected error for unknown kind")
	}
	if !strings.Contains(err.Error(), "unknown kind") {
		t.Fatalf("expected unknown kind error, got: %v", err)
	}
}

func TestEnvelopeValidate_MissingOp(t *testing.T) {
	env := Envelope{Kind: KindControl}
	if err := env.Validate(); err == nil {
		t.Fatal("expected missing op validation error")
	}
}

func TestEnvelopeValidate_ValidKinds(t *testing.T) {
	cases := []Envelope{
		{Kind: KindControl, Op: OpPing},
		{Kind: KindNotify, Op: OpInvalidate},
		{Kind: KindStream, Op: OpEvent},
		{Kind: KindError, Op: OpError},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.Kind, func(t *testing.T) {
			if err := tc.Validate(); err != nil {
				t.Fatalf("Validate returned error: %v", err)
			}
		})
	}
}

func TestNewErrorEnvelope(t *testing.T) {
	env := NewErrorEnvelope(CodeInvalidMessage, "bad message")
	if env.Kind != KindError || env.Op != OpError {
		t.Fatalf("unexpected envelope kind/op: %+v", env)
	}

	payload, err := ParseErrorPayload(env.Payload)
	if err != nil {
		t.Fatalf("parse error payload: %v", err)
	}
	if payload.Code != CodeInvalidMessage || payload.Message != "bad message" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestNewSubErrorEnvelope(t *testing.T) {
	resource := &Resource{Type: "turn", Id: "t1"}
	env := NewSubErrorEnvelope("s1", resource, CodeSubscribeFailed, "failed")

	if env.SubId != "s1" {
		t.Fatalf("unexpected subId: %s", env.SubId)
	}
	if env.Resource == nil || *env.Resource != *resource {
		t.Fatalf("unexpected resource: %+v", env.Resource)
	}

	payload := ErrorPayload{}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.Code != CodeSubscribeFailed {
		t.Fatalf("unexpected code: %s", payload.Code)
	}
}
