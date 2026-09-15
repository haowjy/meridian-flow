# features/agents — Agent identity and binding

This feature turns the account/system Agent catalog into writer-facing identity and
composer selection. Server catalog policy lives outside this directory.

- General is a real system entry. Creation reserves its exact catalog-entry and
  definition-revision IDs, just like any other Agent.
- Render a picker for prospective creation. Existing conversations display the
  retained definition, including before their first turn.
- Reuse the composer toolbar's current-value trigger/status family; do not build
  feature-local selector chrome.
- Keep Agent identity name-led. Human avatar imagery stays human-only.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing Agent
selection, binding, or identity presentation.
