# features/project/dock — Dock document container

The right dock holds the chat on Work/Editor and the context rail on Chat.
A single editable document can cover that occupant on Work or Chat; it uses
`ContextDocumentHost` and `DocumentPaneChrome`, just like Editor tabs.
The dock owns no session, room, capture or review controller. Review lists live
in the composer, identity row, phone sheet and Work page, not a Changes view.

The dock header uses `DockDocumentIdentity` over the shared `DocumentIdentityBar`: Close document and Open in Editor (`DockDocumentCommands`), the navigable path, the version chip, and Collapse dock pinned right; the review controls follow on the same line or wrap to a second one. The body passes `identity: null` to avoid repeating the filename. Renaming and moving belong to file lists.

## Contracts

- Keep the primary body mounted at the same tree depth across center/dock
  placement. Cover it with an inert overlay instead of unmounting it.
- Document opens claim the existing revision. Commit only the latest claim;
  Close, project/Work fences and later opens supersede older attempts.
- Persist account-stamped document layout in browser-tab sessionStorage.
  Restored candidates stay hidden until workspace hydration and identity
  validation. Restore never claims a revision or overrides a writer pick.
- `DesktopProjectController` owns rail hand-off of visible documents. Commit
  on accepted navigation, install the Editor tab before consuming the panel.
  Browser history and phone navigation never hand off. Peeks create no tabs
  and stay outside the URL; Close returns to the native occupant.
- The document shares the project's one presented-document review. Its review
  address lives on the occupant and persists with it. Draft-only settlement and
  address writes never bump the revision, so a writer's open in flight wins.
- A document the catalog no longer places closes the slot and reports itself
  to the dock's removed-documents notice (`RemovedNoticeStore`, surface
  `dock`), shown beside "Recent" on Chat's rail. See
  `../context/.context/resource-catalog-and-editor-lifecycle.md`.
- The dock slot owns its material. Keep document shells transparent. Do not
  stack custom `border-border-subtle` with another border-color class in `cn`.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for restoration, hand-off and
menu contracts, and [`../../draft-review/AGENTS.md`](../../draft-review/AGENTS.md)
for review ownership.

## Review launch

Only the presenting container requests the selected review or pending address;
Editor hosts may also request an admissible launch intent: same Work and document identity. Admission does not
wait for the draft list; the review's fresh entry read owns absence. The launch
and address owners own no paint state. Pane continuity belongs to
[`PaintHold`](../../../components/app/PaintHold.md); navigation stays outside it.
Only finished paint replaces its snapshot; loading statuses and token handoff
gaps retain it. Launch and command adapters do not manage the copy.

A launch may name `focusOperationIds`. The claimant that enters the review
mounts `FocusOpenedReview`, which focuses and scrolls to the change holding
them once, when that very review has painted and its preview has loaded. A
review being left that is still painted is never focused, and ids no longer in
the preview open the review at the top. The route can settle before the Editor
has mounted the document, with the address already naming the draft: the address
owner restores no review for a draft whose launch is still unclaimed
(`usePendingEditorReviewItemKey`), because a restore is a second launch and the
latest launch decides the focus.
