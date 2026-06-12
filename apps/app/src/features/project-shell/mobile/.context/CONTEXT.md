# project workspace/mobile — Phone project workspace shell

The phone project workspace is a **sibling shell** of the desktop project workspace, not a
responsive branch inside `Project workspaceShell`. `Project workspaceView` selects it through
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
Only the chrome changes: top bar, drawer, and one active view at a time.

## Contracts

### Route ownership is the navigation model

The project workspace route owns all phone navigation state:

| Param | Meaning |
|---|---|
| `?screen=` | Active primary project workspace destination: `home`, `chat`, or `context`. |
| `?results=` | Phone Results auxiliary surface. Presence means open; desktop ignores it. |
| `?thread=` | Active chat thread. It rides along when switching screens. |
| `?scheme=` | Active context source (`kb`, `user`, `work`, `fs1`). |
| `?folder=` | Active folder within the scheme. Empty/root is omitted. |
| `?path=` | Active file path within the scheme. |

Handlers push by default, not replace, so browser/OS back walks screen changes,
Results open/close, and context drill-in levels. Replacement is reserved for
route normalization (stale thread ids, explicit controller calls that pass
`{ replace: true }`).

Results is auxiliary state, not a primary destination. Opening Results sets
`?results=` while preserving the underlying `?screen=` / `?thread=` state; Back
closes it by returning to the previous URL. Closing with the top-bar
`MessageSquare` also clears only `?results=`. Desktop does not normalize or
fallback this param because its rail already surfaces Results.

Load-bearing context invariant: **when a file is open, `folder === dirname(path)`**.
`handleSelectContextPath()` pins `folder` to the file's parent directory. The
mobile breadcrumb depends on this: folder ancestry doubles as the document
screen's ancestor trail.

Do not set URL params inside mobile leaf components. They call the route-owned
handlers passed through `ProjectViewProps`.

### Primary screens derive from `SCREENS`

`features/project workspace/shell/screens.ts` has one primary destination registry:
`SCREENS`. Route validation derives legal `?screen=` values from it. Settings and
Results are not entries there because they are routed auxiliary surfaces
(`?settings=` and `?results=`), not drawer/sidebar destinations.

### Document sessions: mobile is a registry owner

Mobile documents are read-only for users but live for AI edits. Editable context
documents still mount `EditorView` with the TipTap/Yjs binding active:

```tsx
<EditorView editable={false} showToolbar={false} showCollaborationDecorations={false} />
```

`MobileDocumentHost` owns the registry open-set for the phone route. It retains
exactly the active editable document under the owner id
`mobile-project workspace-document-host`, retains `[]` when no editable document is open,
and releases the owner on unmount. This is separate from the desktop tab strip's
open-tab set; phone navigation derives the active tab from the context tree and
does not write to desktop tabs.

This ownership is mandatory. Mounting `EditorView` directly without `retain()`
creates Yjs sessions that the registry cannot know are closed.

## Architecture

```text
Project workspaceView
  └─ HydratedProject workspace
       ├─ usePhoneShell() === true  → MobileProject workspace
       └─ usePhoneShell() === false → DesktopProject workspace

MobileProject workspace
  ├─ MobileTopBar
  │   ├─ hamburger on every screen
  │   ├─ breadcrumb for context screens
  │   └─ chat ⇄ results trailing action
  ├─ one active main view
  │   ├─ MobileHomeScreen → HomeOverviewBody + phone list chrome
  │   ├─ MobileChatHost → ChatScreen + MobileKeyboardAware
  │   ├─ MobileContextBrowser or MobileDocumentHost
  │   └─ MobileResultsView → ResultsRailBody + MobileResultViewerOverlay
  └─ NavigationDrawer → Sheet + ThreadPanel + account menu
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
- Context screens supply a left-aligned breadcrumb immediately after the
  hamburger. The breadcrumb is Files-rooted: `Files › scheme › folders › file`.
- Home/chat/results use centered titles. The leading hamburger and trailing
  action reserve are both `44px`, so non-breadcrumb titles remain centered.
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

Create-file/create-folder remains desktop-only in `ContextTreePanel`; the phone
browser is read/open/navigation only for now.

### Results auxiliary surface

`MobileResultsView` is a project workspace-scoped full-screen auxiliary surface. It
reuses `ResultsRailBody` as the single source of result-listing logic and opens
result rows in `MobileResultViewerOverlay`, whose full-screen close chrome lives
under `mobile/`.

Results are reached only from the chat top bar:

- Chat shows the Results action (`Sparkles`).
- Results shows the way back to Chat (`MessageSquare`).
- Opening sets `?results=` as a route push so OS/browser back closes it.
- Results do not depend on the current thread; they are project workspace-scoped.

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
  `--mobile-keyboard-height` for the chat composer because standalone/PWA modes
  have not always honored `interactive-widget=resizes-content` consistently.

## Patterns

- Add phone-specific chrome in `mobile/`; keep shared content components shared
  as bodies or model hooks.
- Add primary drawer/sidebar destinations to `SCREENS`. Use auxiliary route
  params for surfaces that are not destinations.
- Prefer route pushes for user navigation. Use replace only for normalization or
  for an explicit route-controller reason.
- Preserve the desktop/phone sibling-shell boundary. Do not add phone branches
  to `Project workspaceShell` or desktop slot layout.
- Keep source-level browser quirks commented at the decision point; future
  agents should not have to rediscover iOS Safari behavior.
