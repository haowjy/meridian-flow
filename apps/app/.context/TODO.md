# TODO — apps/app deferred work

- **Prove a Stripe return against the ledger.** `?checkout=success` carries no
  session id and no status endpoint exists, so reconciliation stays best-effort.
  Add a server-provided session-to-ledger correlation before treating the return
  as proof.
- **Insert from the block handle**
  ([#210](https://github.com/haowjy/meridian-flow/issues/210)). The handle menu
  has Turn into but no Insert.
- **Fade the docked toolbar on scroll**
  ([#211](https://github.com/haowjy/meridian-flow/issues/211)). Fade or slide the
  row away while writing or scrolling, back on selection or focus
  (`EditorSurfaceFrame.tsx`).
- **`image` versus `figure`**
  ([#91](https://github.com/haowjy/meridian-flow/issues/91)). Whether `figure`
  should exist at all, or caption and label should be attributes of `image` in a
  block context (`packages/prosemirror-schema`).
- Primary buttons show their own drop shadow under keyboard focus instead of the
  `focus-ring` box-shadow, so focus looks absent. The variant's `shadow-*` class
  overrides the utility (`components/ui/button.tsx`). Make the focus ring win for
  every variant.
- Move the remaining lists onto the shared list components
  (`components/ui/list-row.tsx`, `picker.tsx`): `WorkspaceNavBody`'s rows are not
  `ListRow`s yet; `WorkScopePicker` is a `DropdownMenu`, not a `Picker`; and
  the editor's `SuggestionMenu` keeps its own listbox.
