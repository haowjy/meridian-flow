# project/mobile — Phone project shell

The phone project is a **sibling shell** of the desktop project, not a
responsive branch inside `ProjectShell`. `ProjectView` selects it through
`usePhoneShell()` only for coarse-pointer phone-class viewports:

```text
(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 500px)
```

A narrow desktop window still renders the desktop shell. A landscape phone still
renders the phone shell because the height clause catches short coarse-pointer
viewports. Tablets with phone-sized width at the boundary (`768px`) and iPad-like
landscape heights stay on desktop.

The shell reuses the same route-owned `ProjectViewProps`, data hooks, chat,
context tree, document editor/viewers, results body, and thread drawer content.
Only the chrome changes: top bar, drawer, and one active destination. A local
chat Sheet can open over Work or Editor without navigating or unmounting the
underlying destination. The shell registers it as the dock reveal, so chat
selection outside Chat opens it; its toolbar entry opens it without selecting a
thread. Pending first-send recovery reopens that Sheet after reload. The Sheet
mounts the chat only while open: closing it ends that chat surface.

Same-Work pending document navigation retains the prior document presentation
and breadcrumb until address resolution settles. The shared review-scope owner
supplies that same document identity to both the recovery executor and phone
host; navigation commands always come from the current route. Errors, Work
changes, Results, and screen changes do not reuse that pending projection.

Deferred implementation work is tracked in [TODO](TODO).

## Contracts

### Route ownership is the navigation model

Phone consumes the same UUID project address as desktop. The route parent owns
navigation; mobile leaves call the typed handlers passed through `ProjectViewProps`
and never construct paths or query strings. The first segment beneath
`/p/<project-id>` is always a screen (`/chats[/<chat-uuid>]`,
`/works[/<work-uuid>]`, `/editor[/…]`); context browse and document paths live
under `/editor` and carry scheme and location in path segments. Scratch and
Uploads name their Work with the required `?work` query, never in the path.
`work`, `settings`, `results`, and `view` are the only recognized query keys.
An invalid address shows "This destination is unavailable." in place. The removed `screen`, `thread`, `scheme`, `folder`, and
`path` query parameters are not compatibility inputs.

User navigation normally pushes so browser/OS Back walks destinations, Results,
and context drill-in; canonicalization and an explicitly guarded controller
repair replace. Results is auxiliary state: it preserves the underlying readable
destination and Back closes it. Explicit unavailable or malformed selections
remain inert and must not be rewritten to remembered/default content.

When a file is open, its breadcrumb derives from its parsed path. Mobile leaf
components do not duplicate filename/path parsing or URL mutation.

### Primary screens derive from `SCREENS`

`features/project/shell/screens.ts` has one primary destination registry:
`SCREENS`. It supplies shell destination vocabulary, not browser query parsing.
Settings and Results are auxiliary routed surfaces (`?settings=` and
`?results=`), not drawer/sidebar destinations.

### Document sessions: mobile is a registry owner

Mobile documents are read-only for users but live for AI edits (a review's draft
body too). Editable context
documents still mount `EditorView` with the TipTap/Yjs binding active:

```tsx
<EditorView editable={false} showToolbar={false} showCollaborationDecorations={false} />
```

`MobileDocumentHost` owns the registry open-set for the phone route. It retains
exactly the active editable document under the owner id
`mobile-project-document-host`, retains `[]` when no editable document is open,
and releases the owner on unmount. This is separate from the desktop tab strip's
open-tab set; phone navigation derives the active tab from the context tree and
does not write to desktop tabs.

The same resolved editable document is published into the persistent Editor
review value. When that value selects a draft, the host resolves its review room
and supplies the Work-qualified review identity to the existing `EditorView`;
phone review does not own a parallel controller or state machine.

This ownership is mandatory. Mounting `EditorView` directly without `retain()`
creates Yjs sessions that the registry cannot know are closed.

### Draft review on the phone

`MobileDocumentReview` wraps the editor of both document hosts (a live document
and a pending new document) and adds the review's chrome while that document is
under inline review. The column keeps one place in the tree whether or not a
review is open, so entering and leaving never remounts the warm live editor;
the review editor mounts beside it and swaps in, as on desktop (`EditorView`). Nothing here owns
review state: the header runs `useReviewHeader`, the bar and sheet run
`useReviewChanges`, both over the Editor scope's controller, the same hooks the
desktop header and dock use. Optimistic Apply and Discard, refusals held on the
change, toasts (no Undo), the entry hold (`inlineReview.shown`) and "No changes
left" with Next draft are therefore the desktop's behaviour, not a copy of it.

- **Header** (`MobileReviewHeader`): the draft switcher, the stepper and the
  list button (with the change count when there are changes), in a 48px row under
  the top bar. The list button stays whatever the count: the sheet is the Work's
  file list and Apply all, and the open file is always in it. Apply draft, Discard
  draft and Show changes live in the switcher's menu (with this document's Live
  and Draft versions and Rename), so the row stays short; Apply all and Discard
  all are the sheet's menu. A refused
  whole-draft command, "No changes left" and "Formatting changes remain" take a
  line under it.
- **Bar** (`MobileChangeBar`): a tap on a change selects it (the inline-review
  plugin's mousedown handler, reached by the compatibility mousedown a tap fires;
  verified in Chromium touch emulation, not on an iPhone) and its bar sits at the bottom of the
  manuscript column, in the page's flow so nothing is hidden behind it. It clears
  `env(safe-area-inset-bottom)` or the on-screen keyboard
  (`--mobile-keyboard-height`, from `MobileKeyboardAware`, which the review column
  uses). The desktop's margin bar steps aside on the phone shell.
- **Sheet** (`MobileChangeSheet`): the list button opens THIS document's changes
  as a bottom sheet over the dimmed manuscript, with the same body the desktop
  identity row's popover shows (`draft-review/DocumentChanges`: changes, Applying,
  No changes left with Next draft, formatting-only) in its `touch` form, and
  "All changes in <Work>" at its foot (`WorkChangesLink`, one transition to the
  Work's Files tab; absent in No Work). It lists no other file and has no Apply
  all or Discard all: those are the Work page's. It opens and stays open at zero
  changes. A row tap closes the sheet and focuses the change; Apply and Discard
  act and leave it open. The toast rides the sheet's top edge, since the scrim
  covers the manuscript's own.
- Every control is a 44px target (`touch` on `ReviewChangeRow`, `ReviewChangeBar`,
  `ReviewStepper` and `DraftSwitcher`).
- The review body is read-only on the phone, like the live document. A tap must
  select a change, not raise the keyboard over its bar, and the phone has none of
  the editing chrome (the desktop's block grip shows once a caret is placed).
  Making the draft editable is one prop (`editable` on `EditorView`) plus those two
  pieces of work. The desktop's struck-removal click (caret beside the removal)
  does nothing on this read-only body.
- A live document with a pending draft shows the version chip (`DraftReviewChip`,
  `touch`) under the top bar; its Draft item opens the review. The composer
  strip and Work files are the other entries.

## Architecture

```text
ProjectView
  └─ HydratedProject
       ├─ usePhoneShell() === true  → MobileProject
       └─ usePhoneShell() === false → DesktopProject

MobileProject
  ├─ MobileTopBar
  │   ├─ hamburger on every screen
  │   ├─ breadcrumb for context screens and `Chats › <chat switcher>` on Chat
  │   ├─ Open chat action outside Chat
  │   └─ trailing slot: chat ⇄ results toggle, or `+` create menu in Files
  ├─ one active main view
  │   ├─ ChatIndex or WorkScreen → one screen scroll owner
  │   ├─ MobileChatHost → ChatScreen + MobileKeyboardAware
  │   ├─ MobileContextBrowser or MobileDocumentHost
  │   └─ MobileResultsView → ResultsRailBody + MobileResultViewerOverlay
  ├─ local chat Sheet → ChatSurface above the retained Work/Editor view
  └─ NavigationDrawer → Sheet + WorkspaceNavBody + ContextTreePanel + account menu
```

Phone shell views mount/unmount as the active screen changes. Persistent desktop
view-lift rules do not apply to the phone chrome. The state that must survive is
kept in lifted models: thread store/transport, route state, React Query data, and
the document session registry.

### Top-bar model

`MobileTopBar` owns only phone navigation chrome.

- The hamburger is unconditional on every screen. There is **no back button**.
  Up-navigation happens through breadcrumb ancestors; level-pop navigation
  happens through OS/browser back because drill-in pushes route states.
- Every destination shows a truncated project title above its screen identity.
  Context screens keep a left-aligned breadcrumb on the second line; the
  breadcrumb remains Files-rooted: `Files › scheme › folders › file`.
- Chat uses the same breadcrumb grammar (`ChatBreadcrumb`): `Chats` is a
  never-truncating ancestor that opens the index, and the current segment is
  the chat switcher. The index shows a lone `Chats`, so its body hides the
  duplicate heading (`namedByChrome`). Work and Results keep a centered title;
  the leading side reserves as many 44px slots as the trailing side. Crumb
  targets stay 44px with negative margin so the trail fits the 56px band. The drawer edits the
  project title inline without closing, and offers an explicit View projects link.
- Outside Chat, a separate Open chat action opens a local Sheet without
  changing the destination. The registered dock reveal and pending first-send
  reload recovery open the same Sheet and select its Chat tab. The Sheet renders
  `ChatSurface` with `renderHeader` supplying `MobileChatSheetHeader`: a 56px
  status-bar-aware header carrying the chat switcher and a 44px close, built
  from `MobileTopBar`'s chrome primitives rather than the desktop `DockHeader`.
  Like the desktop dock it has no index, so no `Chats` trail. The Sheet opens
  only over Work or Editor: on the Chat screen commands navigate instead of
  revealing.
- The trailing slot is a per-screen dispatcher (`trailingAction()` in
  `MobileProject`): chat carries the Results entry, Results carries the way
  back to chat, and the Files browser inside a scheme (scheme root or folder,
  no file open) carries the `+` create menu (`MobileCreateEntryMenu`). The
  Files root and all other screens leave it empty.
- The bar is solid `bg-background`, not `backdrop-filter`. On iOS Safari,
  backdrop-filter layers flash gray when the view below remounts; the content
  below this bar is flat, so blur bought nothing.

### Breadcrumb behavior

`MobileBreadcrumb` is a location trail, not a screen title.

- The last segment is current and non-interactive.
- Ancestor segments are 44px-tall tap targets.
- Deep trails with more than four segments keep the first segment and last two,
  eliding the middle: `Files › … › parent › current`.
- Width priority is asymmetric. The current segment wins; ancestors shrink first.
  This protects the file or folder the user is looking at on a phone-width bar.

### Drill-in Files browser

`MobileContextBrowser` replaces the desktop expand/collapse tree with
one-folder-per-screen navigation.

- Files root lists context **schemes as sources**, not folders.
- Scheme rows use `schemeIcon()` identity icons. Generic folder icons are
  reserved for real directories inside a scheme.
- Entering a scheme clears folder/path and starts at scheme root.
- Entering a folder clears any open file and pushes the new `folder`.
- Opening a file pushes `path` and pins `folder` to the parent directory.
- A missing folder from a stale URL is rendered as an honest dead-end, not
  silently rewritten by the browser component.
- Upload rows omit generic Delete on phone as well as desktop. Draft-owned
  removal remains the identity/revision-bound intake operation.

### Create file / folder

Creation is "where you are": the top bar's `+` (`MobileCreateEntryMenu`, a
phone sibling of the desktop `CreateContextEntryMenu` — same
`ContextCreateKind` vocabulary, 44px chrome) opens an inline naming row
pinned above the folder listing, targeting the route's current scheme +
folder. The pending kind lives in `MobileProject` because the entry point
is top-bar chrome while the row renders in the browser; any navigation
abandons an uncommitted row.

- `MobileCreateRow` mirrors the desktop CreateRow's submit semantics: Enter
  (keyboard Done) commits, Escape or empty commit cancels, blur with content
  commits. Shared logic stays canonical: `useCreateContextEntry` mutation and
  the `context-entry-name` join/validation helpers — no extension handling on
  either shell; names are created exactly as typed.
- After create the user stays in the listing; the new row appears via the
  mutation's tree invalidation. Folders don't auto-drill and files don't
  auto-open — a new file is empty and the phone editor is read-only (the
  agent fills it). This deliberately diverges from desktop, which opens new
  files as tabs.
- The `+` shows for all four schemes: every scheme is writable server-side
  (fs1 falls back to its offline ContextFS mirror when the project workspace is down),
  matching the desktop tree's per-scheme `+`.
- The row's input is 16px (`text-base`) — smaller fonts make iOS Safari zoom
  the page on focus, which fights the locked phone shell.

### Results auxiliary surface

`MobileResultsView` is a project-scoped full-screen auxiliary surface. It
reuses `ResultsRailBody` as the single source of result-listing logic and opens
result rows in `MobileResultViewerOverlay`, whose full-screen close chrome lives
under `mobile/`.

Results are reached only from the chat top bar:

- Chat shows the Results action (`Sparkles`).
- Results shows the way back to Chat (`MessageSquare`).
- Opening sets `?results=` as a route push so OS/browser back closes it.
- Results do not depend on the current thread; they are project-scoped.

### Filename chrome ownership

The top bar names the current screen/location once. Inner views suppress their
own duplicate headers on phone by composing body-only shared modules with phone
chrome:

- `MobileDocumentHost` renders `EditorView` without toolbar/header chrome and
  disables collaboration cursor/selection decorations through the typed editor
  option.
- Non-tracked mobile documents use `ContextViewerBareHost`, which composes the
  read-only viewer frame without a name/path header because the breadcrumb
  already names the file.
- `MobileResultsView` renders `ResultsRailBody` bare because the top bar already
  says Results.
- `MobileResultViewerOverlay` owns full-screen result chrome; the shared result
  content owns signed-URL resolution and read-only viewer composition.

If adding a new phone content view, decide whether the top bar or the view owns
that name. Do not render both.

## iOS Safari decisions

These are deliberate browser decisions, not incidental styling:

- **No `<meta name="theme-color">` in `__root.tsx`.** With the locked `100svh`
  shell, tinting Safari's status/URL bar to the app background made the notch
  and address bar read washed-out white on real iPhones. Safari's default system
  gray looked correct. The manifest `theme_color` still applies to installed
  PWAs.
- **Global tap-highlight reset.** `globals.css` sets
  `-webkit-tap-highlight-color: transparent`; pressed feedback comes from
  explicit `active:` states instead of Safari's translucent gray overlay.
- **Solid top bar.** The top bar avoids `backdrop-filter` to prevent gray flashes
  during view remount/repaint on iOS Safari.
- **Sheet scrim duration matches panel duration.** The shadcn/Radix Sheet overlay
  uses 500ms open / 300ms close, matching `SheetContent`. The default 150ms
  scrim fade un-dimmed the page while the drawer was still moving.
- **NavigationDrawer transform-clipping wrapper.** The animated `SheetContent`
  stays transparent and unclipped. Rounded corner, clipping, background, and
  shadow live on an inner wrapper because WebKit can blank child content when a
  transform-animated element also has `overflow:hidden` and `border-radius`.
- **Radix `onOpenAutoFocus` is explicit.** The drawer prevents Radix's default
  focus on the first nav item, then focuses the sheet container. This avoids an
  unwanted programmatic focus ring on iOS while keeping the focus trap engaged.
- **Keyboard clearance uses `visualViewport`.** `MobileKeyboardAware` exposes
  `--mobile-keyboard-height` for the chat composer and the review's change bar
  because standalone/PWA modes have not always honored
  `interactive-widget=resizes-content` consistently.

## Patterns

- Add phone-specific chrome in `mobile/`; keep shared content components shared
  as bodies or model hooks.
- Add primary drawer/sidebar destinations to `SCREENS`. Use auxiliary route
  params for surfaces that are not destinations.
- Prefer route pushes for user navigation. Use replace only for normalization or
  for an explicit route-controller reason.
- Preserve the desktop/phone sibling-shell boundary. Do not add phone branches
  to `ProjectShell` or desktop slot layout.
- Keep source-level browser quirks commented at the decision point; future
  agents should not have to rediscover iOS Safari behavior.
