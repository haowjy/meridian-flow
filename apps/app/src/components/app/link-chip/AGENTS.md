# components/app/link-chip — shared link appearance

The single internal/external link treatment ([link chips][link-chips]). Link
meaning, classification, resolution and follow policy belong to
[`core/editor/links`](../../../core/editor/links/AGENTS.md).

- Surfaces spread `linkChipAttributes()` and don't invent or restyle chips. The
  fill is an ink overlay, so no surface sets its own chip tone.
- Don't make Editor hover depend on a role on the `<a>`.
- Core names families and doesn't import icons.

[link-chips]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/link-chips.md
