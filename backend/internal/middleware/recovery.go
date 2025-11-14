package middleware

import (
	"log/slog"
	"net/http"
	"runtime/debug"

	"meridian/internal/httputil"
)

// Recovery middleware recovers from panics and returns a 500 error
func Recovery(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if err := recover(); err != nil {
					logger.Error("panic recovered",
						"error", err,
						"path", r.URL.Path,
						"method", r.Method,
						"stack", string(debug.Stack()),
					)

					httputil.RespondError(w, http.StatusInternalServerError, "internal server error")
				}
			}()

			next.ServeHTTP(w, r)
		})
	}
}
