package billing

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	billing "meridian/internal/domain/billing"
)

func TestCreditGranter_InitializeSignupCredits_FirstTimeGrant(t *testing.T) {
	store := &mockCreditStore{
		balance: &billing.CreditBalance{
			TotalBalanceMillicredits:       300000,
			PromotionalBalanceMillicredits: 300000,
		},
	}
	svc := NewCreditGranter(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	fixedNow := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fixedNow }

	result, err := svc.InitializeSignupCredits(context.Background(), billing.InitializeSignupCreditsRequest{
		UserID:        "user-1",
		Email:         "writer@example.com",
		AuthProvider:  "google",
		EmailVerified: true,
	})
	if err != nil {
		t.Fatalf("InitializeSignupCredits returned error: %v", err)
	}

	if result.CreditsGranted != billing.MonthlyRefreshMillicredits {
		t.Fatalf("CreditsGranted = %d, want %d", result.CreditsGranted, billing.MonthlyRefreshMillicredits)
	}
	if result.AlreadyInitialized {
		t.Fatalf("AlreadyInitialized = true, want false")
	}
	if store.lastCreateGrantReq.GrantReason != "monthly_refresh_2026_03" {
		t.Fatalf("GrantReason = %q, want %q", store.lastCreateGrantReq.GrantReason, "monthly_refresh_2026_03")
	}
	if store.lastCreateGrantReq.ExpiresAt == nil {
		t.Fatalf("ExpiresAt is nil")
	}
	wantExpiry := fixedNow.AddDate(0, 0, billing.MonthlyRefreshExpirationDays)
	if !store.lastCreateGrantReq.ExpiresAt.Equal(wantExpiry) {
		t.Fatalf("ExpiresAt = %v, want %v", store.lastCreateGrantReq.ExpiresAt, wantExpiry)
	}
}

func TestCreditGranter_InitializeSignupCredits_DuplicateGrantNoop(t *testing.T) {
	store := &mockCreditStore{
		createGrantErr: billing.ErrGrantLotAlreadyExists,
		balance: &billing.CreditBalance{
			TotalBalanceMillicredits:       450000,
			PromotionalBalanceMillicredits: 450000,
		},
	}
	svc := NewCreditGranter(store, slog.New(slog.NewTextHandler(io.Discard, nil)))

	result, err := svc.InitializeSignupCredits(context.Background(), billing.InitializeSignupCreditsRequest{
		UserID:        "user-1",
		EmailVerified: true,
	})
	if err != nil {
		t.Fatalf("InitializeSignupCredits returned error: %v", err)
	}

	if !result.AlreadyInitialized {
		t.Fatalf("AlreadyInitialized = false, want true")
	}
	if result.CreditsGranted != 0 {
		t.Fatalf("CreditsGranted = %d, want 0", result.CreditsGranted)
	}
}

func TestCreditGranter_InitializeSignupCredits_UnverifiedEmailSkipsGrant(t *testing.T) {
	store := &mockCreditStore{}
	svc := NewCreditGranter(store, slog.New(slog.NewTextHandler(io.Discard, nil)))

	result, err := svc.InitializeSignupCredits(context.Background(), billing.InitializeSignupCreditsRequest{
		UserID:        "user-1",
		EmailVerified: false,
	})
	if err != nil {
		t.Fatalf("InitializeSignupCredits returned error: %v", err)
	}

	if result.CreditsGranted != 0 {
		t.Fatalf("CreditsGranted = %d, want 0", result.CreditsGranted)
	}
	if store.lastCreateGrantReq.UserID != "" {
		t.Fatalf("CreateGrantLot should not be called for unverified email")
	}
}
