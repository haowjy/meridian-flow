# Live product review: ChatGPT

Date: 2026-06-05

Live browser sampling at `chatgpt.com` (desktop ~960–1440px and mobile ~390px) with side-by-side snapshots of Meridian Flow at `https://phase-1.app.meridian.localhost/` (home, independent `/chat/:id`, project workspace chat). Patterns only — not a visual clone. Warm Paper stays distinct.

**Sampling limits:** No existing conversation history in the test account; sending a live message was blocked by automation policy. Streaming, stop, regenerate, and active-thread layout transitions are **not observed** in this session — noted under blockers.

---

## Summary

ChatGPT optimizes for **fast chat entry** with a two-pane shell (sidebar + centered column), a **mode-aware composer** (`+` menu bundles attach + capability toggles), and a **dual composer placement**: vertically centered on the empty-state landing, bottom-pinned once the user is in chat flow (mobile always bottom). Navigation is keyboard-forward (`Ctrl+K` search, shortcuts in sidebar labels). Density is low — generous whitespace, 16px input text, pill composer ~52px tall.

Meridian Flow already matches several structural choices (viewport-locked shell, pinned composer in `ChatSurface`, independent scroll region with `role="log"`). Gaps worth borrowing as **interaction patterns**, not chrome: global search modal, empty-state composer centering on compose surfaces, inline capability toggles near attach, autocomplete starter prompts while typing. Intentional Meridian Flow differences: three-pane project workspace (rail + thread list + chat), research-framed home (agent packages, project cards), domain-specific attach copy, collapsible **Thinking** disclosure blocks.

---

## Layout

### Observations

| Surface | ChatGPT | Notes |
|---------|---------|-------|
| **Desktop shell** | Persistent left sidebar (~260px when expanded) + main column | Collapsed mode shows a narrow icon rail (~52px) with the same nav targets |
| **Sidebar contents** | Primary nav (New chat, Search, Library, Projects, Apps, Codex, More) above chat-history region; profile + Upgrade pinned at bottom | Keyboard hints visible in expanded sidebar (`Ctrl+Shift+O`, `Ctrl+K`) |
| **Main column** | Centered content column ~632px wide inside flexible main pane | Header bar ~52px: model selector left, Upgrade + temporary-chat toggle right |
| **Empty state** | Large `h1` prompt (“What’s on your mind today?”) with composer **vertically centered** in the main pane | Composer is `position: static` in empty state — not docked to viewport bottom |
| **Mobile** | Sidebar hidden; hamburger opens overlay drawer | Main column full width; composer stays bottom-anchored |
| **Scroll ownership** | Main `<main>` fills remaining viewport below header; message list scrolls inside column once a thread exists | Empty state has no message scroll region |

### Transferable rules for Meridian Flow

1. **Compose vs converse are different layouts.** On draft/landing surfaces (`composePinned` in `ChatSurface`), center the composer + hero prompt in the column — mirror ChatGPT’s empty state. On active threads, keep the current bottom-pinned footer overlay.
2. **One scroll owner per pane.** ChatGPT never scrolls the document; neither should Meridian Flow (`app-frame` + designated `role="log"` region — already correct in project chat).
3. **Sidebar scroll is independent.** Chat history scrolls inside the nav column while main chat scrolls separately — matches `source-app-shell-patterns.md` convergent pattern; keep `SidebarContent overflow-auto` when thread lists grow.
4. **Mobile = overlay nav, not a shrunk desktop tree.** ChatGPT swaps sidebar for a drawer at narrow widths — aligns with Meridian Flow’s `AppDrawer` / `useIsDesktop()` split; don’t squeeze three panes onto mobile.

---

## Interactions

### Observations

| Interaction | ChatGPT behavior |
|-------------|------------------|
| **Streaming / stop / regenerate** | *Not observed* — no history and send blocked |
| **Composer attach** | `+` opens popover: “Add photos & files” (`Ctrl+U`), Recent files submenu, capability toggles (Thinking, Deep research, Web search), integrations (OpenAI Platform), Projects submenu |
| **Send affordance** | Send button label becomes “Send prompt” when text is present; disabled/hidden when empty |
| **Typing autocomplete** | Partial input surfaces clickable starter prompts below composer (e.g. “how a city can become more sustainable”) |
| **Voice** | Separate dictation mic and “Start Voice” immersive mode buttons in composer chrome |
| **Search** | `Search chats` opens centered modal with filter field + “New chat” shortcut; `Ctrl+K` advertised in sidebar |
| **Model / settings** | Model selector dropdown in header (shows plan upsell for locked models); “Turn on temporary chat” toggle in header |
| **Sidebar hover/focus** | Active nav item gets pill background (e.g. New chat); items are full-width click targets with icon + label |
| **Tool / artifact cards** | Capability toggles live in the `+` menu, not inline cards in the message stream (none observed in-thread) |

### Transferable rules for Meridian Flow

1. **Bundle attach + mode toggles in one composer menu** instead of scattering capability switches across the header — keeps research modes discoverable without extra top chrome.
2. **Show send only when input is non-empty** — ChatGPT’s “Send prompt” vs hidden state; Meridian Flow already disables send — consider label/state transition for clarity.
3. **Autocomplete starters on partial input** — low-cost engagement on home/compose surfaces; Meridian Flow’s agent-package chips are a stronger research-specific variant — both can coexist.
4. **Global search as modal, not route** — `Ctrl+K` / “Search threads” should jump focus to a command-palette overlay listing threads across projects (Meridian Flow has per-project “Search threads” but no global palette yet).
5. **Expose keyboard shortcuts in sidebar labels** for power users (New chat, Search) — optional text beside Lingui strings on desktop sidebar only.
6. **Keep Thinking / tool disclosure in the message stream** — ChatGPT hides reasoning behind modes; Meridian Flow’s collapsible Thinking blocks are the better research pattern — don’t flatten to ChatGPT’s minimal bubbles.

---

## User flow

### Observations

| Step | ChatGPT |
|------|---------|
| **Landing** | Authenticated user lands on `/` → empty new-chat state with centered prompt |
| **First message** | Type in composer → send → URL gains `/c/:id` (not observed live, inferred from product behavior) |
| **Switch threads** | Sidebar history list, Search modal, or `Ctrl+K` |
| **New chat** | Sidebar “New chat” (top nav + history header), search modal shortcut, `Ctrl+Shift+O` |
| **Empty state** | Single friendly `h1` + centered composer; no project cards or package grid |
| **Model entry** | Header model dropdown before first send; temporary-chat toggle for no-history sessions |
| **Projects** | First-class sidebar section with “New project” — parallel namespace to raw chats |
| **Library / Apps** | Additional sidebar destinations beyond chat — content library and app directory |

### Transferable rules for Meridian Flow

1. **Preserve Meridian Flow’s richer home** (recent projects, agent packages) — ChatGPT’s bare landing is optimized for consumer chat, not research workbench entry. Don’t strip home to a single prompt.
2. **Quick-chat path should feel as frictionless as ChatGPT new-chat** — “Start a quick chat without a project” + `/chat/:id` is the right analogue; ensure it skips project chrome until the user opts in (partially true today).
3. **Thread search before thread list gets long** — promote search near “New chat” in the thread sidebar (Meridian Flow project chat already has Search threads + New chat — good).
4. **Model / agent mode belongs in header or composer menu**, not buried in settings — ChatGPT’s model selector is always one click away.
5. **Optimistic navigation on send** — industry standard (not observed here); Meridian Flow’s explicit reconciliation rule in AGENTS.md already guards duplicates — keep that stricter than ChatGPT.

---

## Density

### Observations

| Element | ChatGPT |
|---------|---------|
| **Message spacing** | *Not observed in-thread* — empty state only |
| **Sidebar rows** | ~40–44px row height feel; icon + label + optional shortcut text; section headings (“Chat history”) in small caps styling |
| **Composer** | Pill radius, ~52px height, 16px / 24px text (matches iOS no-zoom baseline); `+` and send/voice buttons inside the pill |
| **Typography scale** | Empty `h1` large and light; header model name medium weight; sidebar labels regular 14–16px |
| **Chrome vs content** | Empty state: ~70% whitespace, composer + heading as focal content; sidebar is medium-density, main pane ultra-light |
| **Column max-width** | ~632px composer/content column centered in main pane |

### Transferable rules for Meridian Flow

1. **Keep 16px minimum on composer inputs** — ChatGPT aligns with Meridian Flow AGENTS.md iOS baseline; verify `Composer` textarea meets this.
2. **Cap answer column width** — ChatGPT ~632px vs Meridian Flow `--container-chat-column: 48rem` (768px); Meridian Flow is wider — acceptable for research prose, but consider tightening assistant answer measure separately (`text-answer` utility already exists).
3. **Sidebar row density can be slightly tighter than home** — ChatGPT packs more threads per viewport than Meridian Flow’s padded thread list; tune `--sidebar` spacing without losing 44px touch targets on mobile drawer.
4. **Low chrome on independent chat** — ChatGPT mobile minimizes header to hamburger + model; Meridian Flow `/chat/:id` TopBar (back + Create project) is appropriate research chrome — keep it, don’t add ChatGPT’s upgrade funnel.
5. **Pill composer shape is not required** — adopt spacing and affordance density, not ChatGPT’s exact border-radius / monochrome palette.

---

## Meridian Flow comparison (gaps & intentional differences)

| Dimension | ChatGPT | Meridian Flow (observed) | Gap or intentional? |
|-----------|---------|-------------------|---------------------|
| Shell topology | 2-pane (sidebar + chat) | 1-pane home; 2-pane `/chat`; 3-pane project (rail + threads + chat) | **Intentional** — research workspace needs project + extension rail |
| Empty composer placement | Centered in viewport | Home: in-flow in column; `/chat`: bottom-pinned via `ChatSurface` footer | **Gap on compose** — consider `composePinned` centering for draft surfaces |
| Active composer | Bottom-pinned | Bottom-pinned (`ChatSurface` absolute footer) | **Aligned** |
| Scroll region | Main column / `role="log"` in thread | `role="log"` on scroll div in project chat | **Aligned** |
| Global search | `Ctrl+K` modal | Per-project “Search threads”; home has no global palette | **Gap** |
| Attach UX | `+` menu with files + modes | Labeled “Attach scans or reference files” button | **Intentional** copy; could adopt menu bundling |
| Reasoning UX | Mode toggles in `+` menu | Collapsible “Thinking” blocks in stream | **Intentional** — better provenance for research |
| Home landing | Single prompt | Prompt + recent projects + agent packages | **Intentional** workbench entry |
| Streaming controls | *Unobserved* | CopilotKit live-turn reducer | Verify stop/regenerate parity separately |
| Visual identity | Neutral gray/white, pill composer | Warm Paper tokens, card surfaces | **Intentional** — do not import ChatGPT chrome |

---

## Blockers

1. **No live send** — automation policy blocked submitting a ChatGPT message; streaming, stop, regenerate, and post-first-message layout transition were not captured.
2. **Empty account history** — sidebar showed no prior threads; couldn’t observe conversation-list hover states on real items, title truncation, or thread-switch latency.
3. **Active-thread ChatGPT layout unverified** — composer centering vs bottom-pin on empty state is confirmed; bottom-pinned active layout inferred from mobile sampling and industry behavior, not a desktop thread recording in this session.
