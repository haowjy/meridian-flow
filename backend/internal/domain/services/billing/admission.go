package billing

import "context"

// CreditAdmissionChecker checks whether a user can start or continue a billable request.
type CreditAdmissionChecker interface {
	CheckAdmission(ctx context.Context, userID string) error
	HasPurchasedCredits(ctx context.Context, userID string) bool
}
