package billing

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	billing "meridian/internal/domain/billing"
)

func TestCreditAdmissionChecker_PositiveBalanceAdmits(t *testing.T) {
	store := &mockCreditStore{balance: &billing.CreditBalance{TotalBalanceMillicredits: 10}}
	svc := NewCreditAdmissionChecker(store, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if err := svc.CheckAdmission(context.Background(), "user-1"); err != nil {
		t.Fatalf("CheckAdmission returned error: %v", err)
	}
}

func TestCreditAdmissionChecker_ZeroBalanceDenies(t *testing.T) {
	store := &mockCreditStore{balance: &billing.CreditBalance{TotalBalanceMillicredits: 0}}
	svc := NewCreditAdmissionChecker(store, slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := svc.CheckAdmission(context.Background(), "user-1")
	if err == nil {
		t.Fatalf("expected insufficient credits error, got nil")
	}
	if !isInsufficientCreditsError(err) {
		t.Fatalf("expected insufficient credits error, got %v", err)
	}
}

func TestCreditAdmissionChecker_NegativeBalanceDenies(t *testing.T) {
	store := &mockCreditStore{balance: &billing.CreditBalance{TotalBalanceMillicredits: -500}}
	svc := NewCreditAdmissionChecker(store, slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := svc.CheckAdmission(context.Background(), "user-1")
	if err == nil {
		t.Fatalf("expected insufficient credits error, got nil")
	}
	if !isInsufficientCreditsError(err) {
		t.Fatalf("expected insufficient credits error, got %v", err)
	}
}

func TestCreditAdmissionChecker_StoreErrorFailsClosed(t *testing.T) {
	storeErr := errors.New("db unavailable")
	store := &mockCreditStore{balanceErr: storeErr}
	svc := NewCreditAdmissionChecker(store, slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := svc.CheckAdmission(context.Background(), "user-1")
	if !errors.Is(err, storeErr) {
		t.Fatalf("expected store error %v, got %v", storeErr, err)
	}
}
