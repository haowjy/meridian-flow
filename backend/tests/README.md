# Backend Testing

Test artifacts and integration tests for the Meridian backend.

## Insomnia API Testing (Recommended)

### Quick Setup

1. **Install Insomnia**: https://insomnia.rest/download
2. **Open Insomnia** → Application → Preferences → Data → Import Data
3. **Import collections** from `backend/tests/insomnia/`:
   - Start with `01-basic.json` to test server connection
   - Import others as needed: `00-projects.json`, `02-folders.json`, `03-documents.json`, `04-workflows.json`
4. **Done!** All endpoints are ready to test

### What's Included

Collections organized by feature:

- ✅ **`00-projects.json`** - Project CRUD + project tree
- ✅ **`01-basic.json`** - Health check (1 request)
- ✅ **`02-folders.json`** - Folder CRUD operations (6 requests)
- ✅ **`03-documents.json`** - Document CRUD operations (7 requests)
- ✅ **`04-workflows.json`** - Real-world scenarios (7 requests)

Each collection includes:
- Pre-configured requests with numbered sequence
- Environment variables (auto-configured)
- After-response scripts that auto-capture IDs
- Example TipTap JSON payloads

### Testing Workflow

**Quick Test (Recommended order):**
1. Import `01-basic.json` → Run "Health Check"
2. Import `00-projects.json` → Run "Get Project Tree"
3. Import `04-workflows.json` → Run all 7 requests in sequence

**Feature-Specific Testing:**
- Testing folders? Import `02-folders.json`
- Testing documents? Import `03-documents.json`
- Testing workflows? Import `04-workflows.json`

### After-Response Scripts

Collections auto-capture IDs for easy chaining:

```javascript
// Example: After creating a folder
const response = await insomnia.response.json();
if (response && response.id) {
  await insomnia.environment.set('folder_id', response.id);
  console.log('✅ Saved folder_id:', response.id);
}
```

Check the **Console** tab in Insomnia to see captured values.

### Environment Variables

Each collection has its own environment:

**`01-basic.json`:**
- `base_url`: `http://localhost:8080`

**`02-folders.json`:**
- `base_url`, `folder_id`, `subfolder_id`

**`03-documents.json`:**
- `base_url`, `document_id`, `root_document_id`, `folder_id`

**`04-workflows.json`:**
- `base_url`, `nested_doc_id`, `chapters_folder_id`, `chapter1_id`, `archive_folder_id`

### Detailed Documentation

See `insomnia/README.md` for:
- Detailed collection descriptions
- Request-by-request explanations
- Troubleshooting tips
- Advanced usage

## Manual Testing with curl

See `_docs/technical/backend/api-testing-comprehensive.md` for complete curl examples and test scenarios.

## Seeding Test Data

To populate the database with sample data:

```bash
cd backend
make seed           # Regular seed (keeps tables, clears data)
make seed-fresh     # Fresh start (drops tables, recreates, seeds)
```

See `_docs/technical/backend/database-seeding.md` for details.

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

---

**Pro tip:** Use the Insomnia collections for manual testing and visual inspection. Each collection is focused on a specific area, making it easy to test features in isolation! 🚀
