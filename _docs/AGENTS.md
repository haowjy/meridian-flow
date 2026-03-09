# Documentation Rules

**Default: MINIMUM content unless otherwise stated.**

## Core Principles

1. **Diagrams > Words** — A picture is easier to understand than paragraphs
   - Prefer Mermaid diagrams to explain flows, architecture, relationships
   - Use tables for comparisons or lists of issues
   - Keep text minimal — just enough to connect the diagrams

2. **Minimize words** — Every sentence should earn its place
   - Can a diagram replace 3 paragraphs? Use the diagram
   - Can a table replace verbose lists? Use the table
   - Cut ruthlessly; too much text hurts comprehension

3. **Reference, don't duplicate** — Point to code, don't copy it
   - [good] "See `internal/service/document.go:29-33`"
   - [bad] Pasting 50 lines of existing code

4. **Split by purpose, not size** — Each doc should have a single, clear purpose
   - If covering multiple distinct topics → split into separate docs
   - Organize related docs into folders
   - Update index/README to maintain discoverability
   - Guideline: If someone asks "where's the X doc?" and you can't point to one file, structure is wrong

5. **Use frontmatter** for detail level:
   ```yaml
   ---
   detail: minimal | standard | comprehensive
   audience: developer | architect | claude
   ---
   ```

6. **Code examples sparingly** — Only when:
   - Showing a pattern that doesn't exist yet
   - Demonstrating a specific fix/workaround
   - Concept can't be found in existing code

7. **Focus on WHY and WHAT, not HOW** — let the implementation show the how. How can always change. Some How details are important to note (like specific implementation details to ensure efficiency, compliance, etc.), but not always.

8. **Mermaid diagrams** — Use the `/mermaid` skill and verify the mermaid

9. **No emojis** — Do not use emojis in documentation

## Documentation Tiers

1. **Features** (`_docs/features/`) — Start here. What features exist and their status.
2. **High-Level** (`_docs/high-level/`) — Product vision, user stories, MVP specifications.
3. **Technical** (`_docs/technical/`) — Architecture decisions, patterns, cross-cutting concerns. NOT code duplication.
