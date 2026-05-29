# Phase 2 — Feature & Editor Surface Token Consistency

Status: in progress · Owner: product-lead · 2026-05-29
Scope: `frontend-v2/` feature components (activity-stream, threads, chat-scroll,
docs) + editor surfaces. Bring to the same token-consistency + spec-faithfulness
bar as Phase 1. Source of truth: `_docs/design/`.

Audited by three explorers (p34 activity-stream, p35 threads, p36 editor
surfaces) + product-lead direct read of chat-scroll/docs. Findings below are the
**corrected, deduplicated** fix-list — several explorer "SHOULD BE" suggestions
were wrong (mapped `duration-200`→fast instead of moderate; suggested
`text-warning-foreground` for amber *text*); those are fixed here.

## Decisions already made
- **Micro-labels (sub-`text-xs`):** snap all to `text-xs`. No new token. (human, 2026-05-29)
- **`data-slot` on feature components:** NOT required. Lint contract scopes
  `data-slot` to shadcn-derived primitives only; zero feature components have it.
  ~26 explorer findings dropped.
- **Story-file arbitrary values:** out of scope. Stories are harnesses; demo
  layout values (`h-[44rem]`, mask gradients) are not component drift.

## A. Shadows → elevation tokens (the Phase-1 class, extended)
| File | Line | Current | → |
|---|---|---|---|
| `features/chat-scroll/FloatingScrollLayout.tsx` | 332 | `shadow-md` | `shadow-elevation-overlay` |
| `features/threads/components/UserBubble.tsx` | 76 | `shadow-sm` | `shadow-elevation-subtle` |
| `features/threads/composer/ChatComposer.tsx` | 104 | `shadow-sm` + `focus-within:shadow-md` | `shadow-elevation-subtle` + `focus-within:shadow-elevation-overlay` |
| `editor/theme.ts` | 212 | `boxShadow: "0 8px 24px oklch(0 0 0 / 0.08)"` | `var(--elevation-overlay)` |
| `editor/components/EditorModeTabs.tsx` | 34 | `shadow-[0_1px_2px_oklch(0_0_0/0.12)]` | `shadow-elevation-subtle` |
| `editor/components/EditorShell.tsx` | 60 | `shadow-[0_10px_30px_oklch(0_0_0/0.06)]` | `shadow-elevation-overlay` |
| `editor/components/TabbedEditorShell.tsx` | 119 | `shadow-[0_10px_30px_oklch(0_0_0/0.06)]` | `shadow-elevation-overlay` |

Note: theme.ts:212 image shadow (`8px/24px/8%`) is larger than `--elevation-overlay`
(`4px/12px/10%`). Mapping to overlay = no new token value (Phase-1 precedent).
Surface before/after at checkpoint.

## B. Colors → semantic tokens
**B1. Complete the missing primitive `warning` variants** (spec inventory claims
they exist; code lacks them — features open-code amber because of this gap):
- `components/ui/badge.tsx` — add `warning: "bg-warning text-warning-foreground [a&]:hover:bg-warning/90"` (mirror `success`).
- `components/ui/alert.tsx` — add `warning: "border-warning/60 bg-warning/10 text-foreground [&>svg]:text-warning"` (mirror `success`).

**B2. Consume tokens in features:**
| File | Line | Current | → |
|---|---|---|---|
| `features/threads/components/TurnStatusBanner.tsx` | 19 | `border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300` | `border-warning/60 bg-warning/10 text-foreground [&>svg]:text-warning` (Alert-success pattern) |
| `features/threads/components/TurnRow.tsx` | 36-41 | `<Badge variant="outline" className="border-amber-…">` | `<Badge variant="warning">` (use new variant) |
| `editor/components/TabBar.tsx` | 90 | `text-white` | (folded into B3 active-state redesign) |
| `editor/components/TabBar.tsx` | 100 | `isActive ? "text-white" : "text-accent-fill"` | `text-accent-fill` (always; no white-on-teal) |
| `editor/components/TabBar.tsx` | 117 | `hover:bg-white/20` | `hover:bg-foreground/10` (theme-adaptive) |
| `editor/theme.ts` | 295 | `color: "white"` | `var(--primary-foreground)` |
| `editor/title-header/ConnectionStatus.tsx` | 19 | `bg-[oklch(0.700_0.130_80)]` + stale "no --warning token" comment | `bg-warning`; remove comment |

**B3. TabBar active-state spec alignment (visually significant — flag at checkpoint).**
Impl uses a solid teal pill; spec (`components.md` §TabBar) says active =
`--card` bg + `--foreground` text + 2px `accent-fill` **bottom border**.
- `editor/components/TabBar.tsx:89-91` active branch:
  `bg-accent-fill text-white` → `bg-card text-foreground border-b-2 border-accent-fill`
- inactive hover stays `hover:bg-muted hover:text-foreground` (spec: hover `--muted` 50% → `hover:bg-muted/50`).

## C. Durations / easings → tokens (value-preserving)
| File | Line | Current | → |
|---|---|---|---|
| `features/activity-stream/RotatingText.tsx` | 74, 80 | `duration-200` | `duration-moderate` |
| `features/chat-scroll/FloatingScrollLayout.tsx` | 322 | `duration-200` | `duration-moderate` |
| `editor/theme.ts` | 227 | `opacity 100ms ease-out` | `opacity var(--duration-fast) var(--ease-out)` |
| `editor/theme.ts` | 231 | `opacity 80ms ease-in` | `opacity 80ms var(--ease-in)` (keep 80ms reveal exception) |
| `editor/theme.ts` | 248 | `opacity 200ms ease-out` | `opacity var(--duration-moderate) var(--ease-out)` |

## D. Radius → nearest existing token (theme.ts; no new values)
| Line | Current | → |
|---|---|---|
| 101 | `3px` | `var(--radius-sm)` |
| 136 | `0.35rem` | `var(--radius-md)` (0.4rem) |
| 107, 267 | `0.65rem` | `var(--radius-xl)` (0.7rem) |
| 211, 278 | `0.75rem` | `var(--radius-xl)` (0.7rem) |

## E. Editor font / leading → tokens
| Line | Current | → |
|---|---|---|
| `theme.ts` 19 | `fontSize: "16px"` | `var(--editor-font-size)` |
| `theme.ts` 20 | `lineHeight: "1.75"` | `var(--editor-leading)` (1.65) |

## F. Composer spec alignment
| File | Line | Current | → | Spec |
|---|---|---|---|---|
| `composer/composer-theme.ts` | 5 | `fontSize: "14px"` | `var(--text-base)` | text-base |
| `composer/composer-theme.ts` | 19 | `maxHeight: "200px"` | `40vh` | max 40vh |
| `composer/composer-theme.ts` | 13 | `padding: "5px 0"` | `4px 0` | 4px grid |
| `composer/ComposerControls.tsx` | ~117 | send button default `bg-primary` | `bg-accent-fill` + `text-primary-foreground` icon | send = accent-fill |
| `composer/ChatComposer.tsx` | 104 | `border-border/60` | `border-border` | 1px --border |

`composer-theme.ts:46` minHeight 48px — spec says "min 44px"; 48 ≥ 44, **leave**.

## G. Micro font sizes → text-xs (per human decision)
`activity-stream/ActivityBlockHeader.tsx:50`, `ActivityBlock.tsx:152`,
`items/ToolRow.tsx:60` (`text-[11px]`), `threads/composer/ComposerControls.tsx:87`
(`text-[10px]`), `editor/export/ExportDropdown.tsx` (~66/79/88/97, `text-[10px]`)
→ all `text-xs`.

## H. Arbitrary values → utility scale (kill `[Npx]`, use lint-clean utilities)
| File | Line | Current | → |
|---|---|---|---|
| `activity-stream/ItemLine.tsx` | 82 | `pl-[11px]` | `pl-3` (12px) — **must match ContentRow** |
| `activity-stream/items/ContentRow.tsx` | 10 | `pl-[11px]` | `pl-3` (12px) — **must match ItemLine** |
| `editor/components/EditorModeTabs.tsx` | 22 | `h-[30px]` | `h-8` (32px) |
| `editor/components/EditorModeTabs.tsx` | 34 | `h-[26px]` | `h-7` (28px) |
| `editor/components/TabBar.tsx` | 84 | `max-w-[180px]` | `max-w-44` (176px) |

`h-7` already-utility instances (TabBar:86 inner pill, RenameInput:63/82) are
lint-clean — **leave**. Editor shell `min-h-[420px]` (EditorShell:58,
TabbedEditorShell:117) is demo scaffolding — **leave** (no clean utility; not
component drift).

## Confirmed clean / out of scope
- `features/docs/DocWsProvider.tsx`, `features/threads/streaming/ThreadWsProvider.tsx` — pure logic.
- `threads/components/{ImageBlock,PendingTurn,ReferenceBlock,SiblingNav,TurnList}.tsx` — clean.
- `highlight.ts:31` `fontSize:"1.08em"` — optional cleanup (overlaps `.md-h*` sizing), not required.
- All `*.stories.tsx` — harness layout, not component drift.

## Definition of Done (this phase)
1. All A–H applied; grep shows no raw `shadow-[`/`shadow-sm`/`shadow-md`, no
   `amber-`, no `text-white`/`color:"white"`, no `text-[\d`, no `duration-200`
   in the in-scope files.
2. Self-verified: Storybook renders affected stories; computed styles match
   tokens in **light + dark**; `pnpm run lint` clean.
3. `@alignment-reviewer` + `@reviewer` agree (≤2 rounds).
4. Before/after screenshots at checkpoint; human ratifies visual (esp. B3 TabBar
   active state + F composer font 14→16 + A image shadow).
