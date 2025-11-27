# Backend Testing

[Nothing to see here yet], there are manual insomnia tests elsewhere

## Manual Testing with curl

See `_docs/technical/backend/development/testing.md` for minimal curl examples.

## Seeding Test Data

To populate the database with sample data:

```bash
cd backend
make seed           # Regular seed (keeps tables, clears data)
make seed-fresh     # Fresh start (drops tables, recreates, seeds)
```

Details: `backend/scripts/README.md`.

## Unit Tests (Future)

Go unit tests will be placed alongside source files:
- `internal/database/documents_test.go`
- `internal/utils/word_counter_test.go`
- etc.

Run with:
```bash
go test ./...
```

## Integration Tests (Future)

Integration tests will go in:
- `tests/integration/` - Full API integration tests
- `tests/fixtures/` - Test data fixtures
