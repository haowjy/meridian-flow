# features/project — desktop project shell

Route grammar and `?work` are in
[Project Addresses Are Screen-First](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/entry-and-navigation/project-address-grammar.md);
identity order and admission are in
[Routes Find Their Document by Identity](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/documents/identity/route-document-identity.md).

## Desktop shell

Desktop renders a single flat grid with stable direct-child slots:

```text
rail-l | left-resize | center | dock-resize | dock
```

A screen change changes `grid-area` or parks a surface; it doesn't portal, reparent or
conditionally unmount stateful surfaces.

Slot wrappers paint their material, and document shells stay transparent. Slot placement is
derived from the active screen, not persisted. Preferences hydrate before the desktop component
mounts, and `ProjectView` gates the mount rather than placing a conditional between hooks. One
merged layout subscription is the only whole-preferences subscription.

The shell has one toggle inset (`px-2`), so a surface's collapse button and the expand control
that replaces it sit at the same x. Region separation is tonal. Repeated header primitives are
shared, but Chat's dock is not a resizable panel.

## Routes

The authenticated project route keeps `ProjectView` mounted across same-project child paths.
Typed route controllers own push/replace, and leaves parse no URLs. `repairAddress` is reserved
for canonical, entry-guarded replacement.

Rename or move prepares the open tab's new locator and the replacement address as one navigation
commit, so the old address keeps its identity continuity until the new one is accepted.

A tab is its document id; its path, name and owner are a display cache the replica refreshes. A
route is bound to a document only when that is proven: a navigation that names the document (a tab
click, a tree open) binds the route it opens in `commit()` (`enterRoute`), and any other URL (paste,
reload, Back/Forward) stays a candidate until its address answer binds it
(`addressRouteBinding`), so the path's occupant decides there. A tab found by its cached path may
paint but never binds. A bound document the address catalog does not list holds: the answer naming
another document is the path's occupant, so the route waits for the move or removal the availability
stream brings (there is no separate identity lookup: a missed move is the only way in, and the
stream settles it). A review address binds its route to the item's document at once
(`reviewDocumentId` on `ProjectContextRemovalController`) and owns its path: the availability
planner never relocates it, and it is never a candidate for rejection. A selection about another
route than the URL begins again (`ProjectContextRemovalController`), so a binding that lands late
cannot stay stale.
Draft-only tabs are the exception: no catalog lists them, so their cached path still matches.

An empty (No Work) Editor selection lives in href-scoped history state, so Back/Forward and reload
keep it.

Route admission observes only its addressed draft's close lifecycle, never account-wide
Apply/Discard revisions: waking it for command progress rerenders the persistent project tree
before local feedback can paint.

Launching review on another document pushes history. On the current document, or adding or
removing `?item=`, it replaces the entry, so Back never toggles review.

An archived Work's chats stay live, and sending doesn't unarchive.

Work creation, archive, restore, delete, rename and Goal editing keep their own failure and undo
evidence on the destination or row. Command projection is the single optimistic read model, and
account switches clear queued commands. Archive focus follows the Work to its destination tab and,
on refusal, returns to the origin tab if the user hasn't moved focus elsewhere.

## Navigation and chat

`routing/chat-navigation.tsx` is the single command seam: on Chat it changes the route, and
elsewhere it reveals the local dock or phone Sheet. Dock selection doesn't write the URL.

The displayed-chat variant is derived from the URL; a warm chat may stay mounted behind the index
but isn't the displayed chat. Primary-list lookups may supply Work and header projections but never
decide the body identity or reject a subagent.

## Document admission

A bound document with no source is pending, never a cached occupant. Catalog errors and pending
refreshes don't prove absence.

The opening record is taken from the active editor tab, not an intent or create path. It updates
locally before a server POST, and the POST waits for `whenOnServer`. A parked restored tab is not
an open.

Background review launch, paint hold and focus handoff stay with the presenting container; the
document host never invents a second review controller.

## Entry and offline

Child navigation and same-href history-state writes never reload the persistent loaders, which
permits warm offline editing, not cold offline boot. Project creation writes an account-scoped
creation record before navigating: it stands in for loader data while pending or failed and never
grants authority.

The basic `EditorView` is a static dependency of the project hosts, so a loaded empty workspace can
start local writing offline. Library intent and the creation form may warm workspace code but don't
preload the project route loader, which would repeat owner and shell-data reads.

## Related context

- [`editor-document-lifecycle.md`](editor-document-lifecycle.md)
- [`resource-lifecycle-architecture.md`](resource-lifecycle-architecture.md)
- [`../mobile/.context/CONTEXT.md`](../mobile/.context/CONTEXT.md)
- [`../dock/.context/CONTEXT.md`](../dock/.context/CONTEXT.md)
- [`../context/.context/CONTEXT.md`](../context/.context/CONTEXT.md)
- [`../chat-index/.context/CONTEXT.md`](../chat-index/.context/CONTEXT.md)
