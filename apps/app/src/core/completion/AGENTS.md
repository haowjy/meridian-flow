# core/completion — headless suggestion and reference policy

The generation-fenced menu store and the hierarchical reference browser over the
normalized catalog ([one predictive browser][at-references]). Hosts provide trigger
envelopes, geometry, insertion and rendering.

- Keep this package independent of `editor/`, `features/` and rendering libraries.
  No ProseMirror, DOM, React or writer-facing copy crosses this boundary.
- Read callbacks live: `start`, `update`, `exit`, row choice, dismissal, segment
  completion, terminal selection and `anchorRect` aren't copied into a second
  controller.
- One title-matching rule. A second ranking implementation makes two menus
  disagree about one query, and one of them disagrees with the resolver.
- Anything only one surface renders goes in `TMeta` or the host's own state, not
  the shared snapshot.
- Terminal rows already contain an `AuthoritativeReference`. Contextual Work
  syntax isn't reconstructed into stable identity here.

Callback and cold-source details: [`.context/CONTEXT.md`](.context/CONTEXT.md).

[at-references]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/editor/references.md
