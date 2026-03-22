package middleware

import (
	"errors"
	"net/http"

	"meridian/internal/domain"
	billingdomain "meridian/internal/domain/services/billing"
	"meridian/internal/httputil"
)

// CreditGate denies billable requests when the caller has no spendable credits.
func CreditGate(checker billingdomain.CreditAdmissionChecker) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if checker == nil {
				next.ServeHTTP(w, r)
				return
			}

			userID := httputil.GetUserID(r)
			if err := checker.CheckAdmission(r.Context(), userID); err != nil {
				var insufficientErr *domain.InsufficientCreditsError
				if errors.As(err, &insufficientErr) {
					httputil.RespondErrorWithExtras(w, http.StatusPaymentRequired, insufficientErr.Error(), map[string]interface{}{
						"balance_millicredits":   insufficientErr.BalanceMillicredits,
						"required_millicredits":  insufficientErr.RequiredMillicredits,
						"shortfall_millicredits": insufficientErr.ShortfallMillicredits,
					})
					return
				}

				httputil.RespondError(w, http.StatusInternalServerError, "credit admission check failed")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
