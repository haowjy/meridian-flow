package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"meridian/internal/domain"
	"meridian/internal/httputil"
)

type testAdmissionChecker struct {
	err    error
	calls  int
	userID string
}

func (c *testAdmissionChecker) CheckAdmission(_ context.Context, userID string) error {
	c.calls++
	c.userID = userID
	return c.err
}

func (c *testAdmissionChecker) HasPurchasedCredits(_ context.Context, _ string) bool {
	return false
}

func TestCreditGate_AllowsAdmittedRequests(t *testing.T) {
	checker := &testAdmissionChecker{}
	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	})

	handler := CreditGate(checker)(next)
	req := httptest.NewRequest(http.MethodPost, "/api/turns", nil)
	req = httputil.WithUserID(req, "user-123")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d", http.StatusNoContent, recorder.Code)
	}
	if !nextCalled {
		t.Fatalf("expected downstream handler to be called")
	}
	if checker.calls != 1 {
		t.Fatalf("expected checker to be called once, got %d", checker.calls)
	}
	if checker.userID != "user-123" {
		t.Fatalf("expected checker user_id %q, got %q", "user-123", checker.userID)
	}
}

func TestCreditGate_RejectsInsufficientCredits(t *testing.T) {
	checker := &testAdmissionChecker{err: domain.NewInsufficientCreditsError(0, 1)}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	handler := CreditGate(checker)(next)
	req := httptest.NewRequest(http.MethodPost, "/api/turns", nil)
	req = httputil.WithUserID(req, "user-123")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusPaymentRequired {
		t.Fatalf("expected status %d, got %d", http.StatusPaymentRequired, recorder.Code)
	}

	var body map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to parse response body: %v", err)
	}

	if got := int(body["status"].(float64)); got != http.StatusPaymentRequired {
		t.Fatalf("expected body status %d, got %d", http.StatusPaymentRequired, got)
	}
	if got := int64(body["balance_millicredits"].(float64)); got != 0 {
		t.Fatalf("expected balance_millicredits 0, got %d", got)
	}
	if got := int64(body["required_millicredits"].(float64)); got != 1 {
		t.Fatalf("expected required_millicredits 1, got %d", got)
	}
	if got := int64(body["shortfall_millicredits"].(float64)); got != 1 {
		t.Fatalf("expected shortfall_millicredits 1, got %d", got)
	}
}

func TestCreditGate_ReturnsInternalErrorForCheckerFailure(t *testing.T) {
	checker := &testAdmissionChecker{err: errors.New("db unavailable")}
	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	})

	handler := CreditGate(checker)(next)
	req := httptest.NewRequest(http.MethodPost, "/api/turns", nil)
	req = httputil.WithUserID(req, "user-123")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, recorder.Code)
	}
	if nextCalled {
		t.Fatalf("expected downstream handler not to be called")
	}
}
