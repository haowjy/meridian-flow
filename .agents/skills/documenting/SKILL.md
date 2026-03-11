---
name: documenting
description: Code architecture documentation -- maintains high-level structural docs under _docs/technical/ that describe the WHY and WHAT of the codebase. Includes markdown link checker.
user-invocable: false
---

# Code Architecture Documentation

Keep `_docs/technical/` in sync with the codebase's actual architecture -- package relationships, data flows, design decisions. Not implementation details.

## Writing Rules

- **Diagrams over words** -- Mermaid for flows, tables for comparisons
- **Minimize text** -- every sentence earns its place
- **Reference, don't duplicate** -- point to code locations, never paste large blocks
- **WHY and WHAT, not HOW** -- the code shows the how
- **No emojis**
- **Split by purpose** -- each doc covers one thing

## Required Frontmatter

```yaml
---
detail: minimal | standard | comprehensive
audience: developer | architect | claude
---
```

## After Updating Docs

1. Update `_docs/technical/README.md` index if new docs were created
2. Run `.claude/skills/documenting/check-md-links.sh`
3. Validate Mermaid diagrams with the `/mermaid` skill

## Link Checker

```bash
.claude/skills/documenting/check-md-links.sh                    # default: _docs/
.claude/skills/documenting/check-md-links.sh _docs/technical     # specific directory
.claude/skills/documenting/check-md-links.sh _docs --no-wikilinks
.claude/skills/documenting/check-md-links.sh _docs --no-anchors
```
