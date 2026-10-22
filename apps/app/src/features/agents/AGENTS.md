# features/agents — Agent identity and selection

This feature projects the account/system Agent catalog into writer-facing
identity and composer selection. Server catalog policy remains outside it.

- General is a real system catalog entry. Creation reserves its exact
  catalog-entry and definition-revision IDs, as it does for every Agent.
- New-chat selection is prospective until Send reserves it locally. Existing
  conversations display their retained definition, including before the first
  turn; mutable catalog slugs do not redefine provenance.
- The picker is select-only: list selectable rows, omit unavailable Agents, and
  do not put removal or management here. Reuse the composer toolbar's trigger
  and status family.
- Keep identity name-led; human avatar imagery is human-only.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing binding,
selection, or identity presentation.

The catalog remains the authority for availability and retained definition IDs.

Binding and presentation should remain separate so catalog churn cannot rewrite history.
