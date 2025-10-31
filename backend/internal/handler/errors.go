package handler

import (
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/jimmyyao/meridian/backend/internal/domain"
)

// mapErrorToHTTP maps domain errors to HTTP status codes
func mapErrorToHTTP(err error) error {
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return fiber.NewError(fiber.StatusNotFound, "Resource not found")
	case errors.Is(err, domain.ErrConflict):
		return fiber.NewError(fiber.StatusConflict, err.Error())
	case errors.Is(err, domain.ErrValidation):
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	case errors.Is(err, domain.ErrUnauthorized):
		return fiber.NewError(fiber.StatusUnauthorized, "Unauthorized")
	case errors.Is(err, domain.ErrForbidden):
		return fiber.NewError(fiber.StatusForbidden, "Forbidden")
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
	}
}
