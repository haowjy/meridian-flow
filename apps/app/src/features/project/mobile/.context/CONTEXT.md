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
The route parent owns push/replace and invalid-address rendering. Primary
screens are the `SCREENS` registry: Chats, Works, and Editor; Settings and
Trash are auxiliary query surfaces. The navigation drawer's fixed row opens the
full-screen Trash list without changing the mounted primary screen. Selecting a
row shows its read-only document in place; Back returns to the list. Context
browsing and documents live under Editor.
Only the recognized Work/settings/trash/view selectors are accepted, and legacy
screen/thread/scheme/folder/path query keys are not compatibility inputs.

User navigation pushes so OS/browser Back traverses screens and drill-in.
Canonical repair or an explicitly guarded controller may replace. A malformed
or unavailable selection remains in place rather than silently defaulting.
Breadcrumbs derive from the parsed route path; leaves do not duplicate path or
filename parsing.

The top bar has hamburger, project identity, screen/breadcrumb content, and a
per-screen trailing action. It has no back button. Chat outside the Chat screen
opens a local Sheet and leaves the current Work/Editor destination mounted;
chat navigation on Chat changes the destination instead. The phone shell may
mount only its active main screen, unlike desktop persistent surfaces.

## Document registry and review

Mobile documents are read-only for the writer but live for AI edits (a review's
draft body too). Every editable phone document (the ordinary route, the local
pointer and a draft-only document) renders `ContextDocumentHost` directly, inside
a `relative min-h-0 flex-1` frame that is a direct child of a flex column, with
`PHONE_DOCUMENT_PRESENTATION` (`context/document-presentation.ts`). It does not
use `ContextEditorMountHost`, the desktop's warm-set LRU.

The presentation value is the whole phone difference: it never types (no
toolbar; the host's `readOnly` stays the Work's archived scope, which the
room-scope check compares with the room's access), shows no remote carets, names
the body "Read-only live document", suspends presence from the click that
requests a review, and sets the binding owner id `mobile-project-document-host`.
Everything else is the shared host.

The route-owned phone presentation reuses the installed Editor tab's instance
identity. An availability answer committed with that tab therefore reaches the
phone's shared session boundary instead of starting a second lookup.

The phone must stay on the shared session boundary. Only
`ContextTabSessionBoundary` probes local content and holds the adoption-eligible
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

A pending draft exposes a Draft chip on its live view. An empty review stays in
the same draft room and reads "No changes left"; closing a draft-only document
tab is navigation, not Discard or a terminal review card. The read-only body
selects changes instead of opening the
keyboard; mobile review never becomes an editable Editor.

## Files browser and phone chrome

`MobileContextBrowser` chooses a project scheme, then renders its nested subtree
with the same `TreeChildren` rows and inline forms as desktop. Folder disclosure
expands in place. The parsed route still owns the starting scheme/folder and
file navigation; missing folders are honest dead ends. Draft-owned removal
remains identity/revision-bound. The chat Files menu separately combines shared
Scratch with the primary chat's uploads.

The `+` action creates in the current scheme/folder through shared
`ContextCreateKind`, `useCreateContextEntry`, and validation. Enter/Done or
blur with content commits; Escape or empty commit cancels. Navigation abandons
an uncommitted row. Creation stays in the listing: it does not auto-drill or
open a file. The route's current location is the target.

Mobile top chrome names a document once. `MobileDocumentHost` renders the shared
document host without toolbar; non-tracked viewers use a bare host. Breadcrumb ancestors are 44px
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
