package postgres

import (
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// isPgDuplicateError checks if error is a unique constraint violation
func isPgDuplicateError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// 23505 = unique_violation
		return pgErr.Code == "23505"
	}
	return false
}

// isPgNoRowsError checks if error is a "no rows" error
func isPgNoRowsError(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

// isPgForeignKeyError checks if error is a foreign key violation
func isPgForeignKeyError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// 23503 = foreign_key_violation
		return pgErr.Code == "23503"
	}
	return false
}
