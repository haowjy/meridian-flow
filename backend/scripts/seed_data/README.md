# Seed Data (No Frontmatter)

This directory contains markdown documents for seeding the database. Frontmatter is no longer parsed during import. Folder paths come from the directory structure, and document names come from filenames.

## Default Behavior

**Just organize your files in folders, and it works:**

```
Characters/Aria.md            → Folder: "Characters/"          Name: "Aria"
World Building/Geography.md   → Folder: "World Building/"      Name: "Geography"
Characters/Villains/Shadow.md → Folder: "Characters/Villains/" Name: "Shadow"
Quick Notes.md                → Root level                     Name: "Quick Notes"
```

The folder path is derived from the directory structure, and the document name is derived from the filename.

Notes:
- Slashes in names are not allowed. If present, they are sanitized to "-" during import.
- To control folder placement, organize files in directories — there is no metadata override.

## Examples

### Example 1: No Frontmatter (Default Behavior)

**Filename:** `Quick Notes.md` (at root)

```markdown
# Quick Notes

Random thoughts and ideas...
```

**Result:**
- Folder: (root level)
- Document name: "Quick Notes"

### Example 2: Nested Folders (No Frontmatter)

**Filename:** `World Building/Geography.md`

```markdown
# Geography

The Five Kingdoms...
```

**Result:**
- Folder: "World Building/"
- Document name: "Geography"

### Example 3: Use hyphen instead of "/" in names

**Filename:** `Hero-Villain Arc.md`

```markdown
# Hero-Villain Arc
Tracking Aria's moral journey...
```

**Result:**
- Folder: "Characters/" (if placed under `Characters/`)
- Document name: "Hero-Villain Arc"

## Frontmatter

Not supported. Organize files in directories; names come from filenames.

## Import Behavior

- **Merge Mode** (`POST /api/import`): Updates existing documents, creates new ones
- **Replace Mode** (`POST /api/import/replace`): Deletes all documents, then imports

Documents are identified by the combination of folder path (from directories) + name (from filename). If a document with the same path+name exists, it will be updated.

## Folder Creation

Folders are automatically created based on the directory structure. For example, placing a file at `Characters/Villains/The Shadow.md` will create folders `Characters/` and `Characters/Villains/` if needed, then create the document `The Shadow` inside.

## Current Structure

```
scripts/seed_data/
├── Chapters/
│   ├── Chapter 1 - The Beginning/
│   │   ├── Overview.md
│   │   └── Scene 1-3 - Arrival.md
│   └── Chapter 2 - The Academy/
│       └── Overview.md
├── Characters/
│   ├── Aria Moonwhisper.md
│   ├── Professor Thorne.md
│   ├── Hero-Villain Arc.md
│   └── Villains/
│       └── The Shadow.md
├── World Building/
│   ├── Geography.md
│   └── Magic System.md
├── Outline/
│   └── Plot Notes.md
└── Quick Notes.md
```

## Seeding

The seeder automatically:
1. Creates a zip file from all `.md` files in this directory
2. Creates the folder hierarchy based on directories
3. Imports the documents using filenames as names

Run with:
```bash
make seed         # Incremental seed
make seed-fresh   # Drop tables and seed from scratch
make seed-clear   # Clear data only (keep schema)
```
