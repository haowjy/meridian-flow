# Insomnia API Test Collections

Organized test collections for the Meridian API. Collections are split by feature domain for easier navigation and testing.

## Collections Overview

**5 collections, ~95 total requests** (1 health + 25 CRUD + 10 import + 27 advanced + 29 chat)

| # | Collection | Purpose | Requests | Status |
|---|------------|---------|----------|--------|
| 00 | Health | Server health check | 1 | ✅ Active |
| 01 | File System - CRUD | Core CRUD operations (projects, folders, documents) | 25 | ✅ Active |
| 02 | File System - Import | Bulk import operations (merge, replace, edge cases) | 10 | ✅ Active |
| 03 | File System - Advanced | Integration tests, workflows, validations, error scenarios | 27 | ✅ Active |
| 04 | Chat | Complete chat operations (chats, turns, content blocks, parameters, validation) | 29 | ✅ Active |

---

## Collections

### 00 - Health (`00-health.json`)
**Tests:** Server health check

**Requests:**
1. Health Check → returns server status

**Use when:** First time setup, checking if server is running

---

### 01 - File System - CRUD (`01-file-system-crud.json`)
**Tests:** Core CRUD operations for projects, folders, and documents

**Contains 3 request groups with 25 total requests:**

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

**Use when:** Basic file system testing, daily development, CRUD operations

**Important:**
- GET requests have after-response scripts to capture IDs - use if CREATE returns nothing
- CREATE requests handle 409 conflicts gracefully by attempting to capture existing IDs

---

### 02 - File System - Import (`02-file-system-import.json`)
**Tests:** Bulk import operations with merge and replace modes

**Contains 3 request groups with 10 total requests:**

#### 1. Import - Merge Mode (4 requests)
Upsert documents from zip files
- Import Merge (Simple Zip) → upserts documents
- Import Merge (Nested Folders) → auto-creates folder hierarchy
- Import Merge (Duplicates) → updates existing docs
- View Tree (After Merge)

#### 2. Import - Replace Mode (2 requests)
Delete all, then import (dangerous!)
- Import Replace (Clear All First) → **DANGEROUS: deletes all first**
- View Tree (After Replace)

#### 3. Import - Edge Cases (4 requests)
Import error handling and validation
- [EDGE] Empty Zip File → should succeed with 0 documents
- [EDGE] Invalid Zip Structure → error handling
- [EDGE] Document Name Sanitization → slashes → hyphens
- [EDGE] No Files Provided → should return 400

**Use when:** Testing bulk import features, migration scenarios

**Important:**
- No project header required in Phase 1 (project ID is injected by middleware). Insomnia collections may include `X-Project-ID` headers for clarity — they are ignored by the server.
- Replace mode is destructive - use with caution

---

### 03 - File System - Advanced (`03-file-system-advanced.json`)
**Tests:** Integration tests, workflows, edge cases, and error scenarios

**Contains 5 request groups with 27 total requests:**

#### 1. Integration (8 requests)
Cross-feature integration tests
- [INTEGRATION] Auto-Create Nested Folders → deep path
- [INTEGRATION] Create Folder Then Document → manual workflow
- [INTEGRATION] Add Document to Folder → using folder_id
- Path testing (relative/absolute paths for folders and documents)
- Path validation errors

#### 2. Workflows (7 requests)
Realistic end-to-end user scenarios
- Create Deeply Nested Document, View Full Tree
- Create Folder Then Document, Add Document to Folder
- Create Archive Folder, Move Document to Archive, View Final Structure

#### 3. Edge Cases - Validations (5 requests)
Input validation tests (should return 400)
- [VAL] Folder Name with Slash, [VAL] Rename Folder with Slash
- [VAL] Document without folder_path or folder_id
- [VAL] Project with Empty Name, [VAL] Project Name Too Long

#### 4. Edge Cases - Priority Tests (2 requests)
folder_id vs folder_path priority logic
- [PRIORITY] Create - folder_id Wins
- [PRIORITY] Move - folder_id Wins

#### 5. Edge Cases - Error Paths (5 requests)
404s, 409s, and error handling
- [ERROR] Delete Project with Documents → should fail (409)
- [ERROR] Get Nonexistent Document → should return 404
- [ERROR] Get Nonexistent Folder → should return 404
- [ERROR] Create Duplicate Folder Name → should fail (409)
- [ERROR] Create Duplicate Document Name → should fail (409)

**Use when:** Comprehensive testing, CI/CD, debugging edge cases

**Important:**
- Tests realistic user workflows and error scenarios
- Validates business logic and constraints

---

### 04 - Chat (`04-chat.json`)
**Tests:** Complete chat operations with LLM integration

**Contains 6 request groups with 29 total requests:**

#### 1. Basic Operations (5 requests)
Chat CRUD operations
- Create Chat → saves `chat_id`
- List Chats (by project), Get Chat by ID
- Update Chat Title, Delete Chat

#### 2. Turns (5 requests)
Turn operations and conversation tree navigation
- Create Root Turn (user) → saves `turn_id`, triggers LLM response
- Create Child Turn (assistant) → uses debug endpoint for testing
- Create Branch Turn → alternative conversation path
- Get Turn Path (root to turn) → full conversation thread
- Get Turn Children (branches) → view branching points

#### 3. Content Blocks (4 requests)
Different content block types in turns
- Turn with Text Content → simple text message
- Turn with Document Reference → full document context
- Turn with Partial Reference → text selection (start/end positions)
- Turn with Multiple Blocks → mixed content types

#### 4. Request Parameters (8 requests)
LLM parameter testing and validation
- Temperature (0.0 - 1.0) → randomness control
- Thinking Mode (low/medium/high) → extended thinking budgets (2K/5K/12K tokens)
- Top-P and Top-K → sampling parameters
- Custom Model Override → specify model per turn
- Stop Sequences → control response termination
- [VAL] Invalid Temperature → validation error (> 1.0)
- [VAL] Invalid Thinking Level → validation error (unknown level)
- [VAL] Invalid Model → validation error (unsupported model)

#### 5. Integration Tests (2 requests)
Full workflow testing with seeded data
- Full Workflow → create chat, turn, get path (end-to-end)
- Test with Seeded Data → uses pre-seeded chat (UUID: `11111111-1111-1111-1111-111111111111`)

#### 6. Validation Tests (5 requests)
Error handling and edge cases
- [VAL] Invalid Project ID → 404 error
- [VAL] Invalid Prev Turn ID → 404 error
- [VAL] Missing Required Fields → 400 error
- [VAL] Invalid Role Value → 400 error
- [VAL] Invalid Content Block Type → 400 error

**Use when:** Testing chat functionality, LLM integration, or conversation branching

**Important:**
- Run `make seed` to create seeded test chat data
- Create requests auto-capture IDs via after-response scripts
- Debug endpoint (`POST /debug/api/chats/:id/turns`) available in dev mode for creating assistant turns manually
- LLM responses are asynchronous - assistant turns created automatically after user turns

---

## Quick Start

### Import Collections

1. Open Insomnia
2. Go to **Application** → **Preferences** → **Data** → **Import Data**
3. Select **From File**
4. Import collections in order:
   - `00-health.json` → verify server is running
   - `01-file-system-crud.json` → basic CRUD operations
   - `02-file-system-import.json` → bulk import testing
   - `03-file-system-advanced.json` → workflows and edge cases
   - `04-chat.json` → complete chat and LLM testing

**Recommended:** Start with health check, then use CRUD collection for daily development. Import advanced collections only when needed.

## Environment Variables

Each collection has its own environment with:

**Common (all collections):**
- `base_url`: `http://localhost:8080` (change if needed)
- `project_id`: Project UUID for testing

**01-file-system-crud.json** (CRUD environment):
- `project_id`, `test_project_id` (projects)
- `folder_id`, `subfolder_id` (folders)
- `document_id`, `root_document_id` (documents)

**02-file-system-import.json** (Import environment):
- `project_id` (import target)
- Shares environment with other file system collections

**03-file-system-advanced.json** (Advanced environment):
- `nested_doc_id`, `chapters_folder_id`, `chapter1_id`, `archive_folder_id` (workflows)
- `weapons_folder_id` (integration tests)
- Shares base environment with other file system collections

**04-chat.json** (chat environment):
- `chat_id`, `turn_id` (chat and turn IDs)
- `document_id`, `root_document_id` (for document references in content blocks)

## Running Tests

### Sequential Testing (Recommended)

Run requests **in order** within each collection:
- Numbers indicate sequence (1, 2, 3, etc.)
- After-response scripts auto-capture IDs from responses
- Later requests use captured IDs from environment
- **GET requests capture IDs** - use if CREATE returned nothing

### Example Flow

```
01-file-system-crud.json:

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

02-file-system-import.json:
1. Import Merge (Simple Zip)
   ↓ (upserts documents)
2. View Tree (After Merge)
   ↓ (verify import)
...

03-file-system-advanced.json:
1. [INTEGRATION] Auto-Create Nested Folders
   ↓ (tests deep path creation)
2. [WORKFLOW] Create Archive Folder
   ↓ (realistic scenario)
3. [ERROR] Get Nonexistent Document
   ↓ (validate 404 handling)
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

**Daily development workflow:**
1. 00-health → 01-file-system-crud
   - Basic CRUD operations for projects, folders, documents
   - Fast, focused testing

**Complete file system testing:**
1. 00-health → 01-file-system-crud → 02-file-system-import → 03-file-system-advanced
   - Comprehensive coverage of all file system features

**Test specific features:**
- **Basic CRUD:** Use 01-file-system-crud (Projects, Folders, Documents)
- **Bulk operations:** Use 02-file-system-import (Merge Mode, Replace Mode, Edge Cases)
- **Integration workflows:** Use 03-file-system-advanced (Integration, Workflows)
- **Validation and errors:** Use 03-file-system-advanced (Validations, Priority Tests, Error Paths)

**Test chat:**
1. 00-health → 04-chat
   - Use request groups in order: Basic Operations → Turns → Content Blocks → Request Parameters → Integration → Validation

## Need Help?

- See `../README.md` for full API documentation
- See `../../QUICKSTART.md` for setup instructions
- Check `_docs/technical/backend/api/` for API contracts and examples
- Report issues: GitHub Issues
