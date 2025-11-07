package postgres

import (
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// IsPgDuplicateError checks if error is a unique constraint violation
func IsPgDuplicateError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// 23505 = unique_violation
		return pgErr.Code == "23505"
	}
	return false
}

// IsPgNoRowsError checks if error is a "no rows" error
func IsPgNoRowsError(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

// IsPgForeignKeyError checks if error is a foreign key violation
func IsPgForeignKeyError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// 23503 = foreign_key_violation
		return pgErr.Code == "23503"
	}
	return false
}
