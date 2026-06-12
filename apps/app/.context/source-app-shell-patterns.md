# Source context: app shell & scroll containment

Synthesis from reference repos (`~/.meridian/ref/`). Use when changing
`AppShell`, `app-frame`, `app-scroll`, or sidebar/main scroll boundaries.

Studied: **lobe-chat** (chat + nav shell), **plane** (project workspace),
**cal-com** (legacy vs modern shadcn sidebar in `coss-ui`).

## Convergent patterns (adopt)

| Pattern | lobe-chat | plane | cal-com (coss-ui) | Meridian Flow |
|---------|-----------|-------|---------------------|--------|
| Document lock (`overflow: hidden` on root) | Desktop `100dvh` | `h-screen overflow-hidden` | `min-h-svh` + inset scroll (modern) | `html/body` + `app-frame` |
| Single viewport frame | Yes | Yes | Partial (legacy uses doc scroll) | Yes (`app-frame`) |
| Inner scroll opt-in | Per-region `overflow-y: auto` | `ContentWrapper` | `ScrollArea` / flex child | `app-scroll` |
| Flex shrink chain (`min-h-0`) | On every flex tier | `h-full` inheritance | `min-h-0 flex-1` on scroll child | `min-h-0` on inset + scroll |
| Sidebar scroll independent of main | `ScrollShadow` in nav body | `ScrollArea` in sidebar | Sidebar rail scroll | `SidebarContent overflow-auto` |
| Chat: messages scroll, composer pinned | Sibling outside scroll box | N/A | N/A | `ChatSurface` overlay footer |
| Chrome subtracted from shell | Title bar `calc(100% - Npx)` | Top nav in wrapper | Banner height on sidebar | `ConnectionBanner` `shrink-0` |

## Divergent choices (keep Meridian Flow's)

- **`svh` not `dvh`:** AGENTS.md picks `100svh` for stable shell height when the
  mobile address bar shows/hides. `100dvh` tracks dynamic chrome as it animates;
  lobe-chat uses it for that reason. Revisit only if address-bar resize causes a
  measured layout bug (clipped shell, wrong scroll height) — not for iOS input zoom.
- **iOS input zoom (separate track):** Safari auto-zooms focused inputs below 16px
  computed font-size. Fixes live in AGENTS.md § Platform baseline: 16px+ on
  focusable inputs/textarea, `-webkit-text-size-adjust: 100%` on `html`, viewport
  without `maximum-scale=1` (blocks assistive zoom). Do not conflate with `svh`/`dvh`.
- **shadcn `SidebarProvider`:** We use upstream sidebar primitives (same family as
  cal-com `coss-ui`), not lobe's portal-based `NavPanel`.
- **No document scroll fallback on mobile:** lobe unlocks body scroll below 576px;
  we keep one `app-frame` on mobile with `TopBar` + `app-scroll` (matches AGENTS.md).

## Anti-patterns (avoid)

- **`min-h-svh` on shell root** without `max-h` — shell grows with content, layout
  feels oversized and unscrollable regions break (cal-com legacy `min-h-screen`).
  Unrelated to Safari input auto-zoom.
- **Nested `h-svh` inside `app-frame`** — child stacks viewport height (bare view +
  `ProjectView` used to do this; now `h-full min-h-0`).
- **Scroll on `home-column` AND `app-scroll`** — one vertical scroll owner per pane.

## Evidence paths

- lobe-chat: `src/styles/global.ts`, `src/features/NavPanel/SideBarLayout.tsx`,
  `src/routes/(main)/agent/features/Conversation/ConversationArea.tsx`
- plane: `apps/web/app/root.tsx`, `core/components/core/content-wrapper.tsx`
- cal-com: `apps/web/modules/shell/Shell.tsx` (legacy), `packages/coss-ui/src/components/sidebar.tsx` (modern)
