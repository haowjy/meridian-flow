# features/agents — Agent identity and binding

This feature turns the project Agent catalog into writer-facing identity and
composer selection. Server catalog policy lives outside this directory.

- Treat `general` as the synthetic platform default; never send it as an Agent
  binding.
- Render a picker only when selection can change the next send. Frozen-thread
  identity is readonly status, not a disabled picker.
- Reuse the composer toolbar's current-value trigger/status family; do not build
  feature-local selector chrome.
- Keep Agent identity name-led. Human avatar imagery stays human-only.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing Agent
selection, binding, or identity presentation.
