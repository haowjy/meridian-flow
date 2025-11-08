# Insomnia API Test Collections

Organized test collections for the Meridian API. Each collection is organized by feature with all related tests in one place.

## Collections Overview

**3 collections, ~70 total requests** (1 health + 57 file system + 12 chat placeholders)

| # | Collection | Purpose | Requests | Status |
|---|------------|---------|----------|--------|
| 00 | Health | Server health check | 1 | ✅ Active |
| 01 | File System | Complete file operations (projects, folders, documents, import, workflows, edge cases) | 57 | ✅ Active |
| 02 | Chat (PLACEHOLDER) | Chat API skeleton for future testing | 12 | ⚠️ Not implemented |

---

## Collections

### 00 - Health (`00-health.json`)
**Tests:** Server health check

**Requests:**
1. Health Check → returns server status

**Use when:** First time setup, checking if server is running

---

### 01 - File System (`01-file-system.json`)
**Tests:** Complete file system operations organized by feature

**Contains 11 request groups with 57 total requests:**

#### 1. Projects (9 requests)
Project CRUD operations + tree visualization
- List Projects, Create Project, Get Project by ID, Update Project Name
- Delete Project (Empty), Delete Project (Has Documents)
- [VAL] Empty Name, [VAL] Name Too Long
- Get Project Tree

#### 2. Folders (6 requests)
Folder CRUD operations
- Create Root Folder → saves `folder_id`
- Get Folder (captures ID) → **use if CREATE returned nothing**
- Create Subfolder → saves `subfolder_id`
- Rename Folder, Move Subfolder to Root, Delete Folder

#### 3. Documents (10 requests)
Document CRUD operations
- Create Document (Simple - folder_path only)
- Get Document (captures ID) → **use if CREATE returned nothing**
- Create Document (Optimized - folder_id + folder_path)
- Create Root Document → saves `root_document_id`
- Update Document Content, Rename Document
- Move Document via folder_path, Move Document to Folder, Move Document to Root
- Delete Document

#### 4. Integration (3 requests)
Cross-feature integration tests
- [INTEGRATION] Auto-Create Nested Folders → deep path
- [INTEGRATION] Create Folder Then Document → manual workflow
- [INTEGRATION] Add Document to Folder → using folder_id

#### 5. Import - Merge Mode (4 requests)
Upsert documents from zip files
- Import Merge (Simple Zip) → upserts documents
- Import Merge (Nested Folders) → auto-creates folder hierarchy
- Import Merge (Duplicates) → updates existing docs
- View Tree (After Merge)

#### 6. Import - Replace Mode (2 requests)
Delete all, then import (dangerous!)
- Import Replace (Clear All First) → **DANGEROUS: deletes all first**
- View Tree (After Replace)

#### 7. Import - Edge Cases (4 requests)
Import error handling and validation
- [EDGE] Empty Zip File → should succeed with 0 documents
- [EDGE] Invalid Zip Structure → error handling
- [EDGE] Document Name Sanitization → slashes → hyphens
- [EDGE] No Files Provided → should return 400

#### 8. Workflows (7 requests)
Realistic end-to-end user scenarios
- Create Deeply Nested Document, View Full Tree
- Create Folder Then Document, Add Document to Folder
- Create Archive Folder, Move Document to Archive, View Final Structure

#### 9. Edge Cases - Validations (5 requests)
Input validation tests (should return 400)
- [VAL] Folder Name with Slash, [VAL] Rename Folder with Slash
- [VAL] Document without folder_path or folder_id
- [VAL] Project with Empty Name, [VAL] Project Name Too Long

#### 10. Edge Cases - Priority Tests (2 requests)
folder_id vs folder_path priority logic
- [PRIORITY] Create - folder_id Wins
- [PRIORITY] Move - folder_id Wins

#### 11. Edge Cases - Error Paths (5 requests)
404s, 409s, and error handling
- [ERROR] Delete Project with Documents → should fail (409)
- [ERROR] Get Nonexistent Document → should return 404
- [ERROR] Get Nonexistent Folder → should return 404
- [ERROR] Create Duplicate Folder Name → should fail (409)
- [ERROR] Create Duplicate Document Name → should fail (409)

**Use when:** All file system testing - from basic CRUD to complex workflows and edge cases

**Important:**
- GET requests have after-response scripts to capture IDs - use if CREATE returns nothing
- CREATE requests handle 409 conflicts gracefully by attempting to capture existing IDs
- Import uses `X-Project-ID` header instead of body field

---

### 02 - Chat (PLACEHOLDER) (`02-chat.json`)
**Status:** ⚠️ **API NOT YET IMPLEMENTED** - This is a skeleton for future testing

**Contains 5 request groups with 12 placeholder requests:**

#### 1. Chat Sessions (4 requests)
Session lifecycle management
- Create Chat Session, List Chat Sessions
- Get Chat Session, Delete Chat Session

#### 2. Turns (2 requests)
Message exchange (user → AI)
- Create Turn → send message and get response
- Get Turn History → conversation history

#### 3. Streaming (2 requests)
Real-time SSE response streaming
- Stream Response (SSE) → real-time AI response
- Get Cached Response → retrieve completed turn

#### 4. Context (2 requests)
Document context management
- Add Document Context → attach documents to session
- Get Context → view documents in context

#### 5. Advanced (2 requests)
Branching and semantic search
- Branch Conversation → create alternative storyline from turn
- Search Documents → semantic search for chat context

**Use when:** Chat API is implemented (currently placeholder only)

**Note:** All requests will return errors until the chat API is implemented. Use this collection to understand the planned API structure.

---

## Quick Start

### Import Collections

1. Open Insomnia
2. Go to **Application** → **Preferences** → **Data** → **Import Data**
3. Select **From File**
4. Import collections in order:
   - `00-health.json` → verify server is running
   - `01-file-system.json` → complete file system testing
   - `02-chat.json` → (optional) skeleton for future chat API

**Recommended:** Start with health check, then use `01-file-system.json` for all file operations testing.

## Environment Variables

Each collection has its own environment with:

**Common (all collections):**
- `base_url`: `http://localhost:8080` (change if needed)
- `project_id`: Project UUID for testing

**01-file-system.json** (consolidated environment):
- `project_id`, `test_project_id` (projects)
- `folder_id`, `subfolder_id`, `weapons_folder_id` (folders)
- `document_id`, `root_document_id` (documents)
- `nested_doc_id`, `chapters_folder_id`, `chapter1_id`, `archive_folder_id` (workflows)

**02-chat.json** (placeholder environment):
- `session_id`, `turn_id` (chat sessions)
- `document_id`, `root_document_id` (for context)

## Running Tests

### Sequential Testing (Recommended)

Run requests **in order** within each collection:
- Numbers indicate sequence (1, 2, 3, etc.)
- After-response scripts auto-capture IDs from responses
- Later requests use captured IDs from environment
- **GET requests capture IDs** - use if CREATE returned nothing

### Example Flow

```
01-file-system.json:

Projects group:
1. List Projects
   ↓ (see all projects)
2. Create Project
   ↓ (saves project_id)
3. Get Project by ID
   ↓ (uses project_id)
...

Folders group:
1. Create Root Folder
   ↓ (may return nothing if exists, handles 409)
2. Get Folder (captures ID)
   ↓ (ALWAYS captures folder_id from GET)
3. Create Subfolder
   ↓ (uses folder_id, saves subfolder_id)
...

Documents group:
1. Create Document
   ↓ (handles 409 conflicts)
2. Get Document (captures ID)
   ↓ (use if CREATE returned nothing)
...
```

## After-Response Scripts

Collections use scripts to auto-capture IDs:

**Standard CREATE pattern:**
```javascript
const response = await insomnia.response.json();
if (response && response.id) {
  await insomnia.environment.set('document_id', response.id);
  console.log('✅ Saved document_id:', response.id);
} else {
  console.log('ℹ️  No ID returned (may already exist)');
}
```

**GET pattern (always captures):**
```javascript
const response = await insomnia.response.json();
if (response && response.id) {
  await insomnia.environment.set('document_id', response.id);
  console.log('✅ Captured document_id from GET:', response.id);
}
```

**Validation test pattern:**
```javascript
const status = await insomnia.response.getStatusCode();
if (status === 400) {
  console.log('✅ Validation passed: Got expected 400 error');
} else {
  console.log('❌ Expected 400, got:', status);
}
```

Check the **Console** tab in Insomnia to see captured values and test results.

## Testing Tips

1. **Start fresh**: Run `make seed-fresh` before testing to reset database
2. **Use GET to capture IDs**: If CREATE returns nothing (already exists), use GET request to capture ID
3. **Check tree often**: Use "Get Project Tree" to visualize structure after changes
4. **Sequential order**: Run numbered requests in order for best results
5. **Watch console**: Scripts log captured IDs and validation results
6. **Mix and match**: Can use requests from different collections together
7. **Import testing**: Create sample zip files for import tests (see import collection descriptions)

## Troubleshooting

### "document_id not found" or "folder_id not found"
- **Solution 1:** Run the GET request to capture ID (GET always captures IDs)
- **Solution 2:** Run CREATE request first (might return nothing if exists)
- **Solution 3:** Check environment variables are set (click environment dropdown)

### "404 Not Found"
- Check server is running: `make run`
- Verify `base_url` in environment: `http://localhost:8080`
- Ensure the resource exists (run GET request first)

### "409 Duplicate name" errors
- **Expected behavior** for duplicate creation (uniqueness constraint)
- **Solution 1:** Run `make seed-fresh` to reset database
- **Solution 2:** Delete/rename existing items
- **Solution 3:** Use different names for testing

### "400 Validation" errors
- **Expected behavior** for validation tests (check test name for [VAL] tag)
- Verify request body matches API requirements
- Check required fields are present

### Import tests failing
- Ensure zip files exist at specified paths
- Check zip file structure matches expected format
- Verify `X-Project-ID` header is set correctly

### CREATE returns nothing
- **This is normal** - idempotent behavior when resource already exists
- **Solution:** Use the GET request (step 2, 8, etc.) to capture ID from existing resource
- GET requests always have after-response scripts to capture IDs

## Advanced Usage

### Custom Environment

Create a custom environment for different setups:

1. **Development:** `http://localhost:8080`
2. **Staging:** `https://staging-api.meridian.com`
3. **Production:** `https://api.meridian.com` (be careful!)

### Expected Tree Structure

After running workflows collection, expect:

```
Project Tree:
├── World Building/
│   └── Locations/
│       └── Cities/
│           └── Eldergrove
├── Chapters/ (empty, documents moved out)
├── Archive/
│   └── Chapter 1 - The Beginning
├── Characters/
│   └── Aria Moonwhisper (or Aria the Enchantress)
└── Weapons/
    └── Stormcaller Blade
```

### Testing Patterns

**Complete file system testing:**
1. 00-health → 01-file-system
   - Use request groups in order: Projects → Folders → Documents → Integration → Import → Workflows → Edge Cases

**Test specific features:**
- **Basic CRUD:** Use Projects, Folders, Documents groups
- **Integration workflows:** Use Integration and Workflows groups
- **Bulk operations:** Use Import groups (Merge Mode, Replace Mode, Edge Cases)
- **Validation and errors:** Use Edge Cases groups (Validations, Priority Tests, Error Paths)

**Test chat (future):**
1. 00-health → 02-chat
   - Currently returns errors (API not implemented)

## Need Help?

- See `../README.md` for full API documentation
- See `../../QUICKSTART.md` for setup instructions
- Check `_docs/technical/backend/api/` for API contracts and examples
- Report issues: GitHub Issues
