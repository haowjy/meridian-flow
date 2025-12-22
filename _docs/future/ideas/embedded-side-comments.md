# Feature Idea: Embedded Side-Comments

## The Concept

A Google Docs-style commenting system ("highlight text -> show comment on right") that adheres to Meridian's **Local-First** and **AI-First** principles.

Instead of storing comments in a separate database table linked by fragile indices (which break during offline edits or AI rewrites), we **embed the comments directly into the Markdown text**.

## Proposed Syntax

We need a syntax that captures both the *range being commented on* and the *comment content*.

**Format:**
```markdown
[[text to highlight]]{"c": "This is the comment content"}
```

**Example:**
```markdown
The [[rain fell hard]]{"c": "Show, don't tell. Maybe 'The storm hammered the roof'?"}.
She sat by the window.
```

## Why this approach?

1.  **Zero Anchoring Logic:** The comment is physically attached to the text. If you cut-and-paste the paragraph, the comment moves with it. No complex index-shifting logic needed.
2.  **Native AI Visibility:** The AI reads the file content. It sees the comments automatically. You can prompt it: *"Fix the issues mentioned in the comments."*
3.  **Portable:** It works in any text editor (it's just text). The custom UI is just a "progressive enhancement."
4.  **Version Control Friendly:** Git diffs show exactly where comments were added or removed.

## Implementation Architecture

### 1. The Data Layer (Storage)
-   **Database:** Plain text (Markdown).
-   **Parsing:** A utility similar to `extractHunks` (from the Diff View) that parses the `[[...]]` pattern to extract:
    -   `from`/`to` (range of the highlight)
    -   `message` (content of the JSON object)
    -   `id` (hash of content + position, or a generated UUID inside the JSON)

### 2. The Editor Layer (CodeMirror)

We need a `ViewPlugin` that acts as a **Projection**:

**A. In-Text Decorations:**
-   **Hide Syntax:** Use `Decoration.replace` (zero-width widget) to hide `[[`, `]]`, and `{"c": "..."}`.
-   **Highlight:** Use `Decoration.mark` to add a background color (e.g., yellow) to the text inside the brackets.

**B. Sidebar Rendering:**
-   **Layout Manager:** A class that tracks the `Y` coordinates of every highlighted range using `view.coordsAtPos(pos)`.
-   **Collision Detection:** A simple algorithm to prevent comment cards from overlapping in the sidebar (pushing them down if needed).
-   **React Portals:** Render the comment cards into a separate `<div>` positioned next to the editor, but drive their position based on the CodeMirror coordinates.

### 3. User Interaction
-   **Add Comment:** User selects text -> Floating toolbar -> "Add Comment". Editor wraps the selection in the syntax.
-   **Edit Comment:** Click the card in the sidebar -> Updates the JSON inside the text.
-   **Resolve:** Click "Resolve" on the card -> Editor unwraps the text (removes syntax and JSON).

## Challenges to Solve

1.  **Nested Syntax:** What if a user comments on a sentence that already has a comment?
    *   *Solution:* MVP rule: No nested comments. Block the action if selection overlaps existing syntax.
2.  **Scroll Sync:** Ensuring the sidebar comments move smoothly when the editor scrolls.
    *   *Solution:* The `ViewPlugin` runs on every render/scroll. It updates the top-offsets of the sidebar elements.
3.  **JSON Validation:** Ensuring the user doesn't break the JSON manually.
    *   *Solution:* The decorations hide the raw JSON, so casual users won't touch it. Power users editing raw text might break it, so the parser must be resilient (try/catch JSON parse).
