---
detail: minimal
audience: developer
---

# Line-Oriented Edit Commands

## Idea
Add internal `delete_lines` and `replace_lines` commands to `str_replace_based_edit_tool` for large multiline edits.

## Why
- `str_replace` is brittle for long multiline snippets (exact-match + whitespace drift).
- Common edit intent is line-based: "delete lines 52-64", "replace lines 120-148".
- Fewer retry loops reduces tool-round exhaustion.

## Scope
- Keep existing spec-compatible commands (`view`, `str_replace`, `insert`, `create`).
- Add Meridian-only extensions:
  - `delete_lines`: remove inclusive line range
  - `replace_lines`: replace inclusive line range with `new_str`

## Guardrails
- Require explicit inclusive `[start_line, end_line]` validation.
- Reject out-of-range and reversed ranges.
- Preserve current proposal/mutation strategy and review flow.

## Priority
Medium
