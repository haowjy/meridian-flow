# Insomnia API Test Collections

Organized test collections for the Meridian API. Each collection tests a specific area of functionality.

## Collections

### 01 - Basic Operations (`01-basic.json`)
**Tests:** Health check and tree navigation

**Requests:**
- Health Check
- Get Document Tree

**Use when:** First time setup, checking if server is running

---

### 02 - Folders (`02-folders.json`)
**Tests:** Folder CRUD operations

**Requests (run in order):**
1. Create Root Folder → saves `folder_id`
2. Create Subfolder → saves `subfolder_id`
3. Get Folder with Children
4. Rename Folder
5. Move Subfolder to Root
6. Delete Folder (cascades)

**Use when:** Testing folder management

---

### 03 - Documents (`03-documents.json`)
**Tests:** Document CRUD operations

**Requests (run in order):**
1. Create Document (Path Auto-Resolve) → creates folders automatically
2. Create Root Document → saves `root_document_id`
3. Get Document by ID
4. Update Document Content
5. Rename Document
6. Move Document to Folder
7. Delete Document

**Use when:** Testing document management

---

### 04 - Workflows (`04-workflows.json`)
**Tests:** Realistic user scenarios

**Workflow (run in order):**
1. Create Deeply Nested Document → auto-creates folder hierarchy
2. View Full Tree → see structure
3. Create Folder Then Document → manual folder creation
4. Add Document to Folder → using folder_id
5. Create Archive Folder
6. Move Document to Archive
7. View Final Structure

**Use when:** Testing real-world usage patterns

---

## Quick Start

### Option 1: Import All Collections

1. Open Insomnia
2. Go to **Application** → **Preferences** → **Data** → **Import Data**
3. Select **From File**
4. Import each JSON file (they're separate collections)

### Option 2: Import One at a Time

1. Import `01-basic.json` first
2. Test health check and tree
3. Import others as needed

## Environment Variables

Each collection has its own environment with:

**Common:**
- `base_url`: `http://localhost:8080` (change if needed)

**Collection-specific:**
- `01-basic.json`: No variables needed
- `02-folders.json`: `folder_id`, `subfolder_id`
- `03-documents.json`: `document_id`, `root_document_id`, `folder_id`
- `04-workflows.json`: `nested_doc_id`, `chapters_folder_id`, etc.

## Running Tests

### Sequential Testing (Recommended)

Run requests **in order** within each collection:
- Numbers indicate sequence (1, 2, 3, etc.)
- After-response scripts auto-capture IDs
- Later requests use captured IDs from environment

### Example Flow

```
02-folders.json:
1. Create Root Folder
   ↓ (saves folder_id)
2. Create Subfolder
   ↓ (uses folder_id, saves subfolder_id)
3. Get Folder with Children
   ↓ (uses folder_id)
...
```

## After-Response Scripts

Collections use scripts to auto-capture IDs:

```javascript
// Example: After creating a folder
const response = await insomnia.response.json();
if (response && response.id) {
  await insomnia.environment.set('folder_id', response.id);
  console.log('✅ Saved folder_id:', response.id);
}
```

Check the **Console** tab in Insomnia to see captured values.

## Testing Tips

1. **Start fresh**: Run `make seed-fresh` before testing
2. **Check tree often**: Use "Get Document Tree" to visualize structure
3. **Sequential order**: Run numbered requests in order
4. **Watch console**: Scripts log captured IDs
5. **Mix and match**: Can use requests from different collections together

## Troubleshooting

### "document_id not found"
- Run a "Create Document" request first
- Check environment variables are set

### "folder_id not found"
- Run "Create Folder" request first
- Or run a "Create Document (Path Auto-Resolve)" to auto-create folders

### "404 Not Found"
- Check server is running: `make run`
- Verify `base_url` in environment

### "Duplicate name" errors
- Run `make seed-fresh` to reset database
- Or delete/rename existing items

## Advanced Usage

### Custom Environment

Create a custom environment for different setups:

1. **Development:** `http://localhost:8080`
2. **Staging:** `https://staging-api.meridian.com`
3. **Production:** `https://api.meridian.com`

### Folder Structure After Testing

Expected tree structure after running all workflows:

```
├── World Building/
│   └── Locations/
│       └── Cities/
│           └── Eldergrove
├── Chapters/ (empty, moved out)
├── Archive/
│   └── Chapter 1 - The Beginning
└── Characters/ (from 03-documents)
    └── Aria Moonwhisper (or moved/renamed)
```

## Need Help?

- See `../README.md` for full API documentation
- See `../../QUICKSTART.md` for setup instructions
- Check `_docs/technical/backend/api-testing-comprehensive.md` for curl examples

