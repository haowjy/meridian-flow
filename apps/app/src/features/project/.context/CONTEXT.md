# features/project — desktop project shell

This reference covers the persistent desktop workspace, route ownership, Work
and chat navigation, hydration, and document admission. Read [`AGENTS.md`](../AGENTS.md)
first. Phone is a sibling implementation; its details live in
[`mobile/.context/CONTEXT.md`](../mobile/.context/CONTEXT.md).

## Desktop shell

`ProjectView` selects `DesktopProject` or the phone sibling. Desktop renders a
single flat grid with stable direct-child slots:

```text
rail-l | left-resize | center | dock-resize | dock
```

The left rail owns project identity, Chat/Work/Editor navigation, the project
file tree, Scratch, and account controls. The center is the current
 destination. The dock swaps Chat and the context/document rail by destination.
A screen change changes `grid-area` or parks a surface; it does not portal,
reparent, or conditionally unmount stateful surfaces. The dock and all
stateful bodies therefore retain drafts, scroll, and sessions across navigation.

Slot wrappers paint their material. Document shells stay transparent and do not
stack duplicate border classes. Layout preferences are device-local; slot
placement is derived from the active screen, not persisted. Preferences hydrate
before the desktop component mounts, and `ProjectView` gates the mount rather
than placing a conditional between hooks. One merged layout subscription is
the only whole-preferences subscription.

The shell has one toggle inset (`px-2`) so a surface's collapse button and the
expand control that replaces it sit at the same x (click without moving the
mouse), and semantic design-token colors, never raw ones. Region separation is
tonal (no seam borders or shadows) and no band paints its own background. Repeated
header, rail-header, and toggle primitives are shared, but the shell is not a
universal rail wrapper: Chat's dock is not a resizable panel.

## Route and identity ownership

The authenticated project route loads a UUID project parent and keeps
`ProjectView` mounted across same-project child paths. Typed route controllers
own push/replace and parse no URLs in leaves. The path names the primary screen
and document; query carries Work, view, settings, and draft overlays:

```text
/p/<id>/chats[/<chat>]
/p/<id>/works[?view=archived|deleted]
/p/<id>/works/new
/p/<id>/works/<work>[?view=files]
/p/<id>/editor[?work=<work>]
/p/<id>/editor/<scheme>/<path>[?work=…&item=…]
/p/<id>/editor/browse[/<scheme>/<path>]
?settings=<section>
```

Legacy slug, screen/thread query, and old context path shapes are invalid rather
than compatibility aliases. Invalid required identity stays in place and shows
an unavailable destination. `repairAddress` is reserved for canonical,
entry-guarded replacement. A document path is a location, not identity:
resource handle, live catalog membership, and draft admission resolve identity.
Rename/move replaces the path while preserving a review item.

Project content uses absent, no-Work, or explicit Work selection distinctly.
Scratch has either a named Work or a No Work chat lineage; Uploads belong to a
chat, whose handle the address spells. No Work Scratch is addressed by lineage, not an empty Work selector.
Slugs, `@`, and internal IDs never enter context URI authority. Required
selectors are never silently defaulted. Only genuinely absent Editor selection
may use local continuity.

`?work` has one meaning per scheme. Project schemes (manuscript, KB, user,
unfiled) read it as the editing context: absent, empty (No Work), or an id.
Uploads take no Work. Scratch has exactly one owner, `?work=<id>` or
`?chat=<first chat id>`; No Work owns no Scratch, so a Scratch address with
neither or both is invalid. The Editor's Work seeds once from the selected chat
and is independent after; with no chat it is explicit No Work, and the catalog
never picks a first Work for it. An empty (No Work) selection lives in
href-scoped history state so Back/Forward and reload keep it; a copied URL
without the parameter may take local defaults.

Route admission observes only its addressed draft's close lifecycle, never account-wide
Apply/Discard revisions. Command progress belongs to rendering leaves; waking route
admission for it rerenders the persistent project tree before local feedback can paint.

A review address names its draft's Work and item (`?work=` empty for No Work),
so a copied No Work review link opens the same draft whatever Work this
browser last chose. Launching review on another document pushes history;
on the current document, or adding/removing `?item=`, replaces the entry, so
Back never toggles review. A path never refutes identity: rename or move keeps
the review and the item.

The Editor shows a tab by one rule, `isEditorTab`: every scheme except Uploads,
a Work's Scratch only in that Work's Editor, a chat's Scratch in every Editor
(a lineage belongs to no Work).

An archived Work's own content (goal, files) is view-only, and its files open
read-only in the Editor under `ArchivedWorkNotice`. Its chats stay live and
sending does not unarchive; the Work picker never offers an archived Work.

Work detail is id-addressed from creation and can render pending, failed, or
confirmed states without replacing the URL. The account-scoped creation record
is recovery state, not authority. Work catalog snapshots are server-owned;
command projection is the single optimistic read model and account switches
clear queued commands. Work creation, archive, restore, delete, rename, and
Goal editing keep their own failure/undo evidence on the destination or row.
Archive focus follows the Work to its destination tab and, on refusal, returns
to the origin tab if the user has not moved focus elsewhere; its ring follows
the input modality of the command.
Navigation never chooses a project-wide Work and never rebinds a chat.

## Navigation and chat

Navigate first: a create or open pushes the destination immediately, then
background persistence/admission connects it. New chat, chat selection, and
first Send stay in their current pane. `routing/chat-navigation.tsx` is the
single command seam; on Chat it changes the route, elsewhere it reveals the
local dock or phone Sheet. Dock selection does not write the URL.

Current chat and remembered Work are tab-local with sessionStorage precedence
and device-local seed for a new tab. The current chat can be a primary or
subagent identity or none. The displayed-chat variant is derived from the URL;
a warm chat may remain mounted behind the index but is not the displayed chat.
Primary-list lookups may supply Work/header projections but never decide the
body identity or reject a subagent.

Chat index is a paginated, server-filtered, virtualized page. The dock has a
switcher, not the index. Work detail reuses the project chat row and its list
owner; it does not create a second scroll owner.

## Document admission and lifetime

The Editor destination is admitted by the route (`ReadableProjectRoute`) and
presented by `ContextPaneController`, which shows the route's verdict and never
re-asks the live catalog (see `editor-document-lifecycle.md`, who decides what). A bare Editor route shows the recent-document chooser;
selecting a row navigates and never seeds a tab. The document host owns live
session binding. The registry owns browser-local warm tabs and the removal
coordinator owns close fallback, route repair, and continuity.

Admission resolves a bound identity before a path occupant. A bound document
with no source is pending, never a cached occupant. Catalog errors and pending
refreshes do not prove absence. Review launch locates tab, addressed draft,
live catalog, and authoritative identity in one order; a failed launch stays
on its draft/route with retry evidence.

The opening record is taken from the active editor tab, not an intent or create
path. It updates locally before a server POST, and the POST waits for
`whenOnServer`. A parked restored tab is not an open. See
[`editor-document-lifecycle.md`](editor-document-lifecycle.md) for the
publication and retention contract.

Dock documents use the shared context host and one presented-review binding.
A dock peek creates no tab and is not a URL destination. Background review
launch, paint hold, and focus handoff stay owned by the presenting container;
the document host never invents a second review controller.

## Entry and offline

Child navigation and same-href history-state writes never reload the
persistent root/account/project loaders; that permits warm offline editing, not
cold offline boot or bypassing server authorization. Project creation writes
an account-scoped creation record before navigating to its UUID route: it
stands in for loader data while pending or failed and never grants authority.
The basic `EditorView` is a static dependency of the project hosts so a loaded
empty workspace can start local writing offline. Library intent and the
creation form may warm workspace code but must not preload the project route
loader, which would repeat owner and shell-data reads.

## Related context

- [`resource-lifecycle-architecture.md`](resource-lifecycle-architecture.md)
- [`../dock/.context/CONTEXT.md`](../dock/.context/CONTEXT.md)
- [`../context/.context/CONTEXT.md`](../context/.context/CONTEXT.md)
- [`../context/AGENTS.md`](../context/AGENTS.md)
- [`../chat-index/.context/CONTEXT.md`](../chat-index/.context/CONTEXT.md)
