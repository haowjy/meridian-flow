# Seed Data with Optional Frontmatter

This directory contains markdown documents for seeding the database. **Frontmatter is optional** - paths are derived from the directory structure by default.

## Default Behavior (No Frontmatter Needed!)

**Just organize your files in folders, and it works:**

```
Characters/Aria.md            → Folder: "Characters/"          Name: "Aria"
World Building/Geography.md   → Folder: "World Building/"      Name: "Geography"
Characters/Villains/Shadow.md → Folder: "Characters/Villains/" Name: "Shadow"
Quick Notes.md                → Root level                     Name: "Quick Notes"
```

The folder path is derived from the **directory structure**, and the document name is derived from the **filename**!

## Frontmatter Format (Optional Override)

Add YAML frontmatter **only when you need to override** the default behavior:

```yaml
---
path: Custom/FolderPath      # Optional: override the folder path (just folders, not doc name)
name: Custom Name Here       # Optional: override the document name
---
```

### All Fields Are Optional

- **`path`**: Override the **folder path only** (derived from directory structure by default)
  - This is the folder hierarchy, NOT including the document name
  - Example: `path: Characters/Aria` means the folder is "Characters/Aria/"
  - Use when you want to place a file somewhere different than its filesystem location
  - Example: File is in `drafts/` but you want folder to be `Characters/Aria`

- **`name`**: Override the document name (derived from filename by default)
  - **Use this when you need "/" in the document name** (which isn't allowed in filenames)
  - Example: `name: Hero/Villain Arc`
  - Example: `name: Scene 1/3 - Arrival`

- **`tags`**: Array of tags for categorization (future feature)
  - Not yet implemented
  - Example: `tags: [character, protagonist, magic]`

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

### Example 3: Document with "/" in Name (Needs Frontmatter!)

**Filename:** `hero-villain-arc.md` (filesystem-safe)

```yaml
---
path: Characters/Aria Moonwhisper
name: Hero/Villain Arc
---

# Hero/Villain Arc

Tracking Aria's moral journey...
```

**Result:**
- Folder: "Characters/Aria Moonwhisper/" (from frontmatter `path`)
- Document name: "Hero/Villain Arc" ✅ (from frontmatter `name`, contains "/" - not allowed in filenames!)

### Example 4: Override Both Path and Name

**Filename:** `drafts/scene-01.md` (stored in drafts folder locally)

```yaml
---
path: Chapters/Chapter 1 - The Beginning
name: Scene 1/3 - Arrival
---

# Scene 1/3 - Arrival

POV: Aria, Location: Academy Gates...
```

**Result:**
- Folder: "Chapters/Chapter 1 - The Beginning/" (from frontmatter `path`, NOT "drafts"!)
- Document name: "Scene 1/3 - Arrival" (from frontmatter `name`, NOT "scene-01"!)

## When to Use Frontmatter?

**You DON'T need frontmatter for:**
- ✅ Basic organization - just use folders
- ✅ Normal document names
- ✅ Most use cases

**You DO need frontmatter for:**
- 🎯 **"/" in document names** (e.g., "Act 1/Scene 2", "Before/After")
- 🎯 **Custom paths** (file stored in `drafts/` but you want it in `Chapters/`)
- 🎯 **Future features** (tags, metadata)

## Import Behavior

- **Merge Mode** (`POST /api/import`): Updates existing documents, creates new ones
- **Replace Mode** (`POST /api/import/replace`): Deletes all documents, then imports

Documents are identified by the combination of `path` + `name`. If a document with the same path+name exists, it will be updated.

## Folder Creation

Folders are automatically created based on the `path` field. For example:

```yaml
path: Characters/Villains/The Shadow
```

This creates:
1. Folder "Characters" (if doesn't exist)
2. Folder "Villains" inside "Characters" (if doesn't exist)
3. Folder "The Shadow" inside "Villains" (if doesn't exist)
4. Document is placed in the "The Shadow" folder

## Current Structure

```
scripts/seed_data/
├── Chapters/
│   ├── Chapter 1 - The Beginning.md
│   ├── Chapter 2 - The Academy.md
│   └── chapter-01-scene-breakdown.md (→ name: "Scene 1/3 - Arrival")
├── Characters/
│   ├── Aria Moonwhisper.md
│   ├── Professor Thorne.md
│   ├── hero-villain-arc.md (→ name: "Hero/Villain Arc")
│   └── Villains/
│       └── The Shadow.md
├── World Building/
│   └── Magic System.md
├── Outline/
│   └── Plot Notes.md
└── Quick Notes.md
```

## Seeding

The seeder automatically:
1. Creates a zip file from all `.md` files in this directory
2. Extracts and parses the frontmatter from each file
3. Creates the folder hierarchy
4. Imports the documents

Run with:
```bash
make seed         # Incremental seed
make seed-fresh   # Drop tables and seed from scratch
make seed-clear   # Clear data only (keep schema)
```
