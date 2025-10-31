# Backend Testing

Test artifacts and integration tests for the Meridian backend.

## Insomnia API Testing (Recommended)

### Quick Setup

1. **Install Insomnia**: https://insomnia.rest/download
2. **Open Insomnia** → Click "Create" → "Import From" → "File"
3. **Select** `backend/tests/insomnia-collection.json`
4. **Done!** All endpoints are ready to test

### What's Included

The Insomnia collection includes:

- ✅ **Pre-configured requests** - All API endpoints ready to use
- ✅ **Environment variables** - `base_url` and `document_id` auto-managed
- ✅ **Example payloads** - Realistic TipTap JSON samples
- ✅ **Auto-capture script** - Document IDs automatically saved after creation

### Collection Structure

```
Meridian Backend
├── Health Check                    # GET /health
├── Documents
│   ├── List All Documents          # GET /api/documents
│   ├── Get Document by ID          # GET /api/documents/:id
│   ├── Create Document             # POST /api/documents
│   ├── Update Document             # PUT /api/documents/:id
│   └── Delete Document             # DELETE /api/documents/:id
└── Examples
    ├── Create Chapter              # POST with chapter example
    ├── Create Character Profile    # POST with character example
    └── Create World Building Doc   # POST with world building example
```

### Environment Variables

The collection uses these variables (auto-configured):

- `base_url` - Default: `http://localhost:8080`
- `document_id` - Auto-captured from Create requests

### After-Response Script

The "Create Document" and example creation requests include an after-response script that automatically captures the `document_id`:

```javascript
const response = await insomnia.response.json();
if (response && response.id) {
  await insomnia.environment.set('document_id', response.id);
  console.log('✅ Saved document_id:', response.id);
}
```

This means you can:
1. Create a document
2. Immediately use "Get Document by ID" or "Update Document" without manual copying

### Testing Workflow

1. **Health Check** - Verify server is running
2. **Create Document** - Creates a new document (ID auto-saved)
3. **Get Document** - Retrieves the just-created document
4. **Update Document** - Modifies the document
5. **List All** - Verify all documents
6. **Delete Document** - Clean up

### Changing the Server URL

If your server runs on a different port:

1. Click on the environment dropdown (top-left)
2. Edit `base_url` to your server URL
3. All requests will use the new URL

## Manual Testing with curl

See `_docs/technical/backend/api-testing-comprehensive.md` for complete curl examples and test scenarios.

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

Integration tests will go in this directory:
- `tests/integration/` - Full API integration tests
- `tests/fixtures/` - Test data fixtures

## Seeding Test Data

To populate the database with sample data:

```bash
cd backend
make seed
```

See `_docs/technical/backend/database-seeding.md` for details.

---

**Pro tip:** Use the Insomnia collection for manual testing and visual inspection. Reserve curl for CI/CD and automation! 🚀

