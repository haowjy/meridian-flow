# components/app/link-chip — shared link appearance

The single internal/external link treatment ([link chips][link-chips]). Link
meaning, classification, resolution and follow policy belong to
[`core/editor/links`](../../../core/editor/links/AGENTS.md).

- Surfaces spread `linkChipAttributes()` and don't invent or restyle chips. Tone
  changes only through `--link-chip-fill` and `--link-chip-fill-hover`.
- Don't make Editor hover depend on a role on the `<a>`.
- Core names families and doesn't import icons.

[link-chips]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/link-chips.md
