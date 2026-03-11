---
name: documenting
description: Documentation conventions, structure, and quality rules for the Meridian project. Loaded by the documenter agent to ensure consistent documentation.
user-invocable: false
---

# Documentation Conventions

**Default: MINIMUM content unless otherwise stated.**

## Core Rules

1. **Diagrams > Words** -- prefer Mermaid diagrams for flows, architecture, relationships. Use tables for comparisons. Keep text minimal.
2. **Minimize words** -- every sentence earns its place. Can a diagram replace 3 paragraphs? Use the diagram.
3. **Reference, don't duplicate** -- point to code locations (`internal/service/document.go:29-33`), never paste large blocks.
4. **Split by purpose** -- each doc has a single clear purpose. If covering multiple topics, split into separate docs.
5. **Focus on WHY and WHAT, not HOW** -- let the implementation show the how.
6. **No emojis** -- they render poorly.
7. **Code examples sparingly** -- only for patterns that don't exist yet or specific fixes.

## Required Frontmatter

Every doc under `_docs/` must have:
```yaml
---
detail: minimal | standard | comprehensive
audience: developer | architect | claude
---
```

## Documentation Tiers

| Tier | Location | Purpose |
|------|----------|---------|
| Features | `_docs/features/` | What features exist and their status |
| High-Level | `_docs/high-level/` | Product vision, user stories, MVP specs |
| Technical | `_docs/technical/` | Architecture decisions, patterns, cross-cutting concerns |
| Plans | `_docs/plans/` | Implementation plans with status tracking |

## Feature Documentation Sync Rule

When adding or significantly updating a feature:
1. Update `_docs/features/<feature-name>/` with changes
2. Update status in `_docs/features/README.md` if needed
3. Run `./scripts/check-md-links.sh`
4. Commit code + docs together

## Mermaid Diagrams

Always validate with the mermaid skill's check script. Key rules:
- Quote labels with special characters: `["..."]`
- Use `\n` not `<br/>` in labels
- No hardcoded colors -- use Mermaid themes
- See `.claude/skills/mermaid/SKILL.md` for full rules

## What To Document After Implementation

After each phase or significant change:
1. **Find affected docs** -- search `_docs/` for references to changed files/APIs
2. **Update design docs** -- if implementation deviated from plan, update the plan to match reality
3. **Update feature docs** -- if user-facing behavior changed
4. **Update doc indexes** -- if new docs were created, add to relevant README
5. **Check links** -- run `./scripts/check-md-links.sh`

## What NOT To Document

- Implementation details that are obvious from reading the code
- Temporary states or work-in-progress notes (use implementation-log.md instead)
- Copy-pasted code (reference it)
- Anything that will be stale in a week
