package wsutil

import (
	"sync/atomic"
	"testing"
	"time"
)

// TestUnknownControlOpIgnored verifies that control messages with unknown ops are
// silently discarded for forward compatibility. The connection must stay alive.
// Protocol: "Unknown op within a valid kind → silently ignored."
func TestUnknownControlOpIgnored(t *testing.T) {
	auth := &wsTestAuthenticator{}
	var messageCalls atomic.Int32

	h := &wsTestHandler{
		onMessage: func(_ State, _ Envelope) error {
			messageCalls.Add(1)
			return nil
		},
	}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)
	s.RegisterHandler("turn", h)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	// Send an unknown control op — must be silently ignored; no error frame.
	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: "future_op_v99"})

	if env, ok := fake.tryReadServerEnvelope(100 * time.Millisecond); ok {
		t.Fatalf("expected no response for unknown control op, got: %+v", env)
	}

	// Connection must still be alive: a valid stream message must reach the handler.
	fake.pushTextEnvelope(t, Envelope{
		Kind:     KindStream,
		Op:       OpMessage,
		Resource: &Resource{Type: "turn", Id: "turn-1"},
		Payload:  mustMarshal(map[string]string{"x": "y"}),
	})
	if !waitFor(500*time.Millisecond, func() bool { return messageCalls.Load() == 1 }) {
		t.Fatal("expected OnMessage called after unknown op was ignored")
	}
}

// TestMalformedJSONSendsErrorFrame verifies that an inbound frame with invalid JSON
// triggers an INVALID_MESSAGE error frame; the connection stays alive afterward.
func TestMalformedJSONSendsErrorFrame(t *testing.T) {
	auth := &wsTestAuthenticator{}
	var messageCalls atomic.Int32

	h := &wsTestHandler{
		onMessage: func(_ State, _ Envelope) error {
			messageCalls.Add(1)
			return nil
		},
	}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)
	s.RegisterHandler("turn", h)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	// Push a raw malformed JSON text frame (MessageText = 1).
	fake.inbound <- wsFrame{typeID: 1, data: []byte(`{"kind":BROKEN`)}

	errEnv := fake.readServerEnvelope(t, time.Second)
	assertErrorCode(t, errEnv, CodeInvalidMessage)

	// Connection must still be alive: send a valid stream message.
	fake.pushTextEnvelope(t, Envelope{
		Kind:     KindStream,
		Op:       OpMessage,
		Resource: &Resource{Type: "turn", Id: "turn-1"},
		Payload:  mustMarshal(map[string]int{"n": 1}),
	})
	if !waitFor(500*time.Millisecond, func() bool { return messageCalls.Load() == 1 }) {
		t.Fatal("expected connection to remain alive after malformed JSON")
	}
}

// TestMissingKindSendsErrorFrame verifies that a JSON envelope missing the `kind`
// field triggers an INVALID_MESSAGE error frame. Connection stays alive.
func TestMissingKindSendsErrorFrame(t *testing.T) {
	auth := &wsTestAuthenticator{}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	// Frame without `kind` (only has `op`).
	fake.inbound <- wsFrame{typeID: 1, data: []byte(`{"op":"ping"}`)}

	errEnv := fake.readServerEnvelope(t, time.Second)
	assertErrorCode(t, errEnv, CodeInvalidMessage)
}

// TestClientSentNotifyKindSendsError verifies that a client sending a notify-kind
// frame (server→client only lane) receives an INVALID_MESSAGE error.
func TestClientSentNotifyKindSendsError(t *testing.T) {
	auth := &wsTestAuthenticator{}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	fake.pushTextEnvelope(t, Envelope{Kind: KindNotify, Op: OpInvalidate})
	errEnv := fake.readServerEnvelope(t, time.Second)
	assertErrorCode(t, errEnv, CodeInvalidMessage)
}

// TestEndSubFreesSubscriptionSlot verifies that ending active subscriptions frees
// their slots so new subscriptions succeed after hitting the 10-sub ceiling.
func TestEndSubFreesSubscriptionSlot(t *testing.T) {
	auth := &wsTestAuthenticator{}
	var subscribeCalls atomic.Int32
	var unsubCalls atomic.Int32

	h := &wsTestHandler{
		onSubscribe: func(_ State, _ SubscribeRequest) error {
			subscribeCalls.Add(1)
			return nil
		},
		onUnsubscribe: func(_ State, _ string) error {
			unsubCalls.Add(1)
			return nil
		},
	}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)
	s.RegisterHandler("turn", h)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	// Fill all 10 subscription slots.
	for i := 1; i <= 10; i++ {
		fake.pushTextEnvelope(t, Envelope{
			Kind:     KindControl,
			Op:       OpSubscribe,
			SubId:    "sub-" + itoa(i),
			Resource: &Resource{Type: "turn", Id: "turn-" + itoa(i)},
		})
	}
	if !waitFor(time.Second, func() bool { return subscribeCalls.Load() == 10 }) {
		t.Fatalf("expected 10 subscribe calls, got %d", subscribeCalls.Load())
	}

	// 11th subscribe must fail.
	fake.pushTextEnvelope(t, Envelope{
		Kind:     KindControl,
		Op:       OpSubscribe,
		SubId:    "sub-11",
		Resource: &Resource{Type: "turn", Id: "turn-11"},
	})
	errEnv := fake.readServerEnvelope(t, time.Second)
	assertErrorCode(t, errEnv, CodeSubscribeFailed)

	// Unsubscribe 3 slots.
	for i := 1; i <= 3; i++ {
		fake.pushTextEnvelope(t, Envelope{
			Kind:  KindControl,
			Op:    OpUnsubscribe,
			SubId: "sub-" + itoa(i),
		})
	}
	if !waitFor(time.Second, func() bool { return unsubCalls.Load() == 3 }) {
		t.Fatalf("expected 3 unsubscribe callbacks, got %d", unsubCalls.Load())
	}

	// Drain the three OpUnsubscribed ack frames.
	for i := 0; i < 3; i++ {
		ack := fake.readServerEnvelope(t, time.Second)
		if ack.Kind != KindControl || ack.Op != OpUnsubscribed {
			t.Fatalf("expected unsubscribed ack, got %+v", ack)
		}
	}

	// Subscribe 3 new ones in the freed slots — must succeed.
	for i := 11; i <= 13; i++ {
		fake.pushTextEnvelope(t, Envelope{
			Kind:     KindControl,
			Op:       OpSubscribe,
			SubId:    "sub-" + itoa(i),
			Resource: &Resource{Type: "turn", Id: "turn-" + itoa(i)},
		})
	}
	if !waitFor(time.Second, func() bool { return subscribeCalls.Load() == 13 }) {
		t.Fatalf("expected 13 subscribe calls after re-using freed slots, got %d", subscribeCalls.Load())
	}

	// No error frames for the re-subscriptions.
	if env, ok := fake.tryReadServerEnvelope(100 * time.Millisecond); ok {
		t.Fatalf("unexpected frame after re-using freed slots: %+v", env)
	}
}

// TestHeartbeatTimeoutClosesConnection verifies the connection is torn down when
// the client does not respond to a ping within the timeout window.
func TestHeartbeatTimeoutClosesConnection(t *testing.T) {
	auth := &wsTestAuthenticator{}
	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(30*time.Millisecond, 50*time.Millisecond),
		withLogger(testLogger()),
	)

	fake, done := startServeConn(t, s, "project-1")

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	// Read the ping but intentionally do NOT respond with pong.
	ping := fake.readServerEnvelope(t, 200*time.Millisecond)
	if ping.Kind != KindControl || ping.Op != OpPing {
		t.Fatalf("expected ping, got %+v", ping)
	}

	// Server must close after the heartbeat timeout.
	select {
	case <-done:
		// expected
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected serveConn to exit after heartbeat timeout")
	}
}

// TestUnregisteredResourceTypeReturnsError verifies that a stream:message targeting
// a resource type with no registered handler returns an error envelope.
func TestUnregisteredResourceTypeReturnsError(t *testing.T) {
	auth := &wsTestAuthenticator{}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)
	// No handler registered.

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	fake.pushTextEnvelope(t, Envelope{
		Kind:     KindStream,
		Op:       OpMessage,
		Resource: &Resource{Type: "ghost", Id: "r-1"},
		Payload:  mustMarshal(map[string]string{"action": "test"}),
	})

	errEnv := fake.readServerEnvelope(t, time.Second)
	if errEnv.Kind != KindError {
		t.Fatalf("expected error frame for unregistered resource type, got %+v", errEnv)
	}
}
