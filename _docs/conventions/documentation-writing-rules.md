---
detail: standard
audience: developer | claude
---

# Documentation Writing Rules

**Default: MINIMUM content unless otherwise stated.**

## Documentation Philosophy

Documentation is organized in three tiers:

1. **Features** (`_docs/features/`) - **Start here**
   - What features exist and their status
   - Stack-prefixed folders show frontend-only (f-), backend-only (b-), or both (fb-)
   - Concise implementation guides with links to technical details

2. **High-Level** (`_docs/high-level/`)
   - Product vision, user stories, MVP specifications
   - Non-technical stakeholder documentation

3. **Technical** (`_docs/technical/`)
   - Deep-dive architecture documents
   - Detailed implementation patterns and edge cases
   - Referenced from feature docs when needed

## Core Principles

1. **Diagrams > Words** - A picture is easier to understand than paragraphs
   - Prefer Mermaid diagrams to explain flows, architecture, relationships
   - Use tables for comparisons or lists of issues
   - Keep text minimal - just enough to connect the diagrams

2. **Minimize words** - Every sentence should earn its place
   - Can a diagram replace 3 paragraphs? Use the diagram
   - Can a table replace verbose lists? Use the table
   - Cut ruthlessly; too much text hurts comprehension

3. **Reference, don't duplicate** - Point to code, don't copy it
   - correct: "See `internal/service/document.go:29-33`"
   - wrong: Pasting 50 lines of existing code

4. **Split by purpose, not size** - Each doc should have a single, clear purpose
   - If covering multiple distinct topics -> split into separate docs
   - Organize related docs into folders (e.g., `features/fb-authentication/`, `technical/backend/`)
   - Update index/README to maintain discoverability
   - Guideline: If someone asks "where's the X doc?" and you can't point to one file, structure is wrong

5. **Use frontmatter** for detail level:
   ```yaml
   ---
   detail: minimal | standard | comprehensive
   audience: developer | architect | claude
   ---
   ```

6. **Code examples sparingly** - Only when:
   - Showing a pattern that doesn't exist yet
   - Demonstrating a specific fix/workaround
   - Concept can't be found in existing code

7. **Focus on WHY and WHAT, not HOW** - let the implementation show the how. How can always change. Some How details are important to note (like specific implementation details to ensure efficiency, compliance, etc.), but not always.

8. **Mermaid diagrams** - Use dark mode compatible colors:
   - Use darker, saturated colors (e.g., `#2d7d2d` not `#90EE90`)
   - Avoid light pastels that disappear on dark backgrounds
   - Test: colors should be visible on both light AND dark backgrounds

## Mermaid Quick Rules

- Quote labels with spaces/punctuation: `Node["Label"]`, `A -->|"edge"| B`
- Use ASCII operators (`>=`, `<=`) not unicode
- Fix parse errors by adding quotes, not restructuring diagrams

## Example

```markdown
# Database Connections

## Problem
Supabase's PgBouncer pooler (port 6543) doesn't support prepared statements.

## Solution
Auto-detect port 6543 and use `QueryExecModeCacheDescribe`.

## Implementation
See `internal/repository/postgres/connection.go`
```
