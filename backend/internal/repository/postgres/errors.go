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

// IsPgNotNullError checks if error is a NOT NULL constraint violation
func IsPgNotNullError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23502" // not_null_violation
	}
	return false
}

// IsPgCheckConstraintError checks if error is a CHECK constraint violation
func IsPgCheckConstraintError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23514" // check_violation
	}
	return false
}

// GetPgErrorDetails extracts error details for debugging
// Returns: (code, message, detail, column, constraint)
func GetPgErrorDetails(err error) (code, message, detail, column, constraint string) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code, pgErr.Message, pgErr.Detail,
			pgErr.ColumnName, pgErr.ConstraintName
	}
	return "", "", "", "", ""
}
