---
detail: minimal
audience: developer, designer
---
# UX Behaviors

Concrete walkthroughs of what the writer sees and does. Each doc covers one flow end-to-end with editor mockups, state transitions, and edge cases.

| Doc | Flow |
|-----|------|
| [Proposal Review](proposal-review.md) | AI proposes edits, writer accepts/rejects individual hunks |
| [Thread Undo](thread-undo.md) | Writer reverts/reapplies accepted edits days later via thread UI |
| [Auto-Apply Mode](auto-apply-mode.md) | Changes land immediately, writer reverts what they don't like |

## Relationship to Specs

These docs show the **what** from the writer's perspective. The specs cover the **how**:

- Hunk grouping algorithm: [Frontend Diff Model](../spec/frontend-diff-model.md)
- Transaction semantics: [Local-First Authority](../spec/local-first-authority.md)
- Undo mechanics: [Undo Design](../spec/undo.md)
