# project/mobile — phone project shell

This reference covers the phone sibling shell, route ownership, document
registry, review chrome, and phone-only navigation. Read [`AGENTS.md`](../AGENTS.md)
first; shared project contracts remain in [`../.context/CONTEXT.md`](../.context/CONTEXT.md).

## Shell and routes

`ProjectView` selects `MobileProject` only for coarse-pointer phone-class
viewports: `(pointer: coarse) and (max-width: 767px)` or
`(pointer: coarse) and (max-height: 500px)`. A narrow desktop window remains
desktop; a short landscape phone remains mobile.

Mobile consumes typed `ProjectViewProps`. Leaves never parse or construct URLs.
The route parent owns push/replace and invalid-address rendering. The phone has
the desktop's two places, one on screen at a time: main fills the screen and
shows what the address names (a document, a chat, `/chats`'s new-chat composer,
or Recently opened), and the side is a bottom Sheet over it. Settings and Trash
are query surfaces over main; the drawer's Trash row shows the Trash list in the
drawer, and a row there shows its read-only document in main. Only the recognized owner/item/change/settings/trash
selectors are accepted.

The Sheet shows the side's item (`useSideItem`, the same resolution as the
desktop side): a document through `DocumentHost` with `place="side"` and the
phone presentation, or a chat. Its header is the desktop side's: the picker
and Open in main (`MobileSideSheetHeader`). The top bar's button
names what the Sheet will show and is there whenever the side has an item. The
Sheet is closed on arrival and any navigation closes it, so a door followed
from inside it lands in main with the Sheet out of the way. An item placed in the side (a chat
link in a document: `place`, see the project context) opens the Sheet.

User navigation pushes so OS/browser Back traverses screens and drill-in.
Canonical repair or an explicitly guarded controller may replace. A malformed
or unavailable selection remains in place rather than silently defaulting.
Breadcrumbs derive from the parsed route path; leaves do not duplicate path or
filename parsing.

The top bar has hamburger, project identity, breadcrumb, and the side's button.
It has no back button. The phone shell mounts only main's item and the Sheet's,
unlike desktop's kept host. The Sheet closes when the history position changes
(`__TSR_index`), not the entry's key: an address repair that replaces the entry
(a rename) keeps it open.

## Document registry and review

The writer can type in a phone document, as on desktop; a review's draft body
stays read-only. Every editable phone document (the ordinary route, the local
pointer and a draft-only document) renders through `DocumentHost` with the phone presentation
(`PhoneDocumentFrame`): `ContextDocumentHost` inside a `relative min-h-0 flex-1` frame that is a
direct child of a flex column, with `PHONE_DOCUMENT_PRESENTATION`
(`context/document-presentation.ts`). The phone resolves its document with the same
`resolveMainDocument` as the desktop's main (`../views.ts`) and mounts one host.

The presentation value is the whole phone difference: it shows no remote carets,
keeps a review body read-only, suspends presence from the click that requests a review, and sets the binding
owner id `mobile-project-document-host`.
Everything else is the shared host.

The phone must stay on the shared session boundary. Only
`OpenDocumentSessionBoundary` probes local content and holds the adoption-eligible
lease that completes a stranded adoption; a phone that binds the live room itself
is refused with `adoption-pending` while the local copy is reserved.

The same document identity feeds `useActiveReviewBinding`, which leases live
presence. Phone hosts pass requested draft identity; the adapter resolves the
canonical room and Work. A review body is read-only and has no editing toolbar.

`MobileDocumentReview` keeps one wrapper in the tree for live/review
presentation. `MobileReviewHeader` owns the draft switcher, stepper, and list
button; `MobileChangeBar` sits in page flow at the bottom of the manuscript;
`MobileChangeSheet` lists this document's changes and links to Work changes.
All controls use 44px targets. Apply/Discard, refusal holds, toast, and next
change behavior come from shared draft-review state; phone owns only sheet and
phone-layout state. No Apply-all/Discard-all lives in the sheet.

The live view's one version chip sits at the toolbar row's end, as on desktop, with every
draft one pick away; the review's header carries its own once a review is entered. An empty review stays in
the same draft room and reads "No changes left"; closing a draft-only document
is navigation, not Discard or a terminal review card. The read-only body
selects changes instead of opening the
keyboard; mobile review never becomes an editable Editor.

## Drawer and phone chrome

The navigation drawer is the desktop sidebar: the same Write | Chat switch and
`SourcesBody` (the Chat list, the trees, Changes, and Unfiled and Trash at its foot above
the account row), so files are browsed, created, moved and deleted there with the
desktop's rows and forms. Opening a file or a chat from it, or pressing Write or Chat,
closes the drawer once main's navigation commits.

Mobile top chrome names a document once. `PhoneDocumentFrame` renders the shared
document host without toolbar or identity bar; non-tracked viewers use a bare host. Breadcrumb ancestors are 44px
controls, the last segment is current, and deep trails keep the first plus the
last two segments.

Do not add a `<meta name="theme-color">` to the root: with the locked `100svh`
shell, tinting Safari's status and URL bars made the notch read washed-out
white on real iPhones. The manifest `theme_color` still applies to installed
PWAs. Phone review stays read-only (a tap selects a change and never raises the
keyboard); making a draft editable is a deliberate change, not a prop flip.

Keep phone-only chrome in `mobile/` and shared bodies/models outside it. Do not
add phone branches to `ProjectShell` or desktop slot layout. Preserve source
comments for browser-specific behavior such as solid top bars, safe-area
keyboard clearance, and visualViewport sizing.
