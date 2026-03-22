package billing

import "context"

// CreditGranter grants promotional credits (signup bonus and monthly refresh).
type CreditGranter interface {
	InitializeSignupCredits(ctx context.Context, req InitializeSignupCreditsRequest) (*InitializeSignupCreditsResult, error)
	RefreshMonthlyCredits(ctx context.Context, userID string) (*MonthlyRefreshResult, error)
}

// MonthlyRefreshResult is the output of CreditGranter.RefreshMonthlyCredits.
type MonthlyRefreshResult struct {
	CreditsGranted bool  // true if fresh credits were granted this call
	GrantReason    string // e.g. "monthly_refresh_2026_04"
}

// InitializeSignupCreditsRequest is the input to CreditGranter.InitializeSignupCredits.
type InitializeSignupCreditsRequest struct {
	UserID        string
	Email         string
	AuthProvider  string // "google", "github", "email"
	EmailVerified bool
	IPAddress     string // client IP, stored for abuse detection
	UserAgent     string // client UA, stored for abuse detection
}

// InitializeSignupCreditsResult is the output of CreditGranter.InitializeSignupCredits.
type InitializeSignupCreditsResult struct {
	CreditsGranted                 int64 // Millicredits granted (0 if already initialized or email unverified).
	AlreadyInitialized             bool  // True if user was already initialized.
	PromotionalBalanceMillicredits int64
	PurchasedBalanceMillicredits   int64
	TotalBalanceMillicredits       int64
}
