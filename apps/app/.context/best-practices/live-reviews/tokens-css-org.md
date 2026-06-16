# CSS token design & code organization — live review

Hybrid research: Meridian Flow source (canonical), OSS comparables, limited browser sampling of closed-source products.

**Sources read**

| Source | Path |
|--------|------|
| Meridian Flow shared tokens | `packages/design-tokens/src/warm-paper.css` |
| Meridian Flow app bridge + utilities | `apps/app/src/styles/globals.css` |
| Meridian Flow human spec | `DESIGN.md` (repo root), `apps/app/.context/CONTEXT.md` |
| Twenty | `packages/twenty-ui/src/theme/constants/*` → generated `theme-light.css` |
| Documenso | `packages/ui/styles/theme.css`, `packages/tailwind-config/index.cjs` |
| Cal.com coss-ui | `packages/coss-ui/src/styles/globals.css` |

---

## 1. Meridian Flow current model (canonical)

Warm Paper uses a **three-file, three-tier** system. Machine source of truth is CSS; DESIGN.md is the human-readable spec and YAML snapshot for lint/export.

### File layers

```
packages/design-tokens/src/warm-paper.css   ← Tier 1 shared semantics (hex :root vars)
        ↓ @import
apps/app/src/styles/globals.css
  ├─ @theme inline          ← Tailwind v4 bridge (--color-*, --text-*, --shadow-*, --radius-*)
  ├─ :root { project-only } ← app-specific vars (composer fade, answer max-width)
  ├─ @layer base            ← html/body shell defaults
  └─ @utility …             ← Tier 2 composite primitives
```

| Layer | Owns | Does not own |
|-------|------|--------------|
| `@meridian/design-tokens` | Shared Tailwind v4 `@theme` palette, shadows, gradients, status colors, type scale, radii; motion duration | `@utility`, project layout |
| `globals.css` `@theme` | Project-only container widths and shell shadows | Shared palette/type/radius aliases |
| `globals.css` `@utility` | Repeated multi-token compositions | One-off component geometry |
| `DESIGN.md` | Role descriptions, do/don't, YAML mirror | Runtime values (sync from CSS, not the other way) |

### Token naming

Meridian Flow names tokens by **semantic role**, not hue or scale step:

- **shadcn-compatible utility roles:** `--color-background`, `--color-foreground`, `--color-primary`, `--color-card`, `--color-muted`, `--color-border`, `--color-ring`, `--color-sidebar-*`
- **Warm Paper extensions:** `--color-surface-warm|subtle`, `--color-ink-strong|muted|subtle`, `--color-chip-*-bg`, `--color-status-*`, `--shadow-*`, `--background-image-gradient-*`
- **Tailwind source:** `warm-paper.css` declares the real values directly in `@theme`; app-side `@theme` is only for project-specific tokens.

Values are **resolved hex/rgba** in `@theme` (not HSL components). Components consume via Tailwind classes (`bg-surface-subtle`, `text-ink-muted`) — never raw hex in TSX.

Radii publish as explicit `--radius-sm` … `--radius-xl` values in `@theme` so utilities and direct CSS references share one scale.

### Three tiers (spacing + styling discipline)

| Tier | Where | What | Example |
|------|-------|------|---------|
| **1 — Semantic tokens** | `warm-paper.css` + project-only `@theme` in `globals.css` | Cross-surface values two+ components must agree on | `--container-chat-column`, `text-answer`, `shadow-card` |
| **2 — `@utility` primitives** | `globals.css` | Multi-token class stacks repeated ≥2 places | `surface-card`, `prose-tokens`, `focus-ring` |
| **3 — Tailwind scale** | TSX | Component-internal spacing/geometry | `gap-2`, `p-3`, `mb-4` |

**Promotion rules (Tier 3 → 2 → 1):**

1. Repeated className stack in **≥2 places** → new `@utility` in `globals.css`.
2. New visual concept in **≥2 places** → new Tier 1 token in `warm-paper.css` (shared) or project `@theme`/`:root` (app-only), then consume the token directly.
3. Magic pixels (`text-[13px]`, `gap-[7px]`) in TSX are a smell — round to Tailwind scale or promote to Tier 1/2.
4. Thin React wrappers (`ChatColumn`) may only pin a utility name; no extra layout logic.

### Tier-2 layout utilities (shell + columns)

These encode the viewport-locked project shell documented in DESIGN.md § Layout:

| Utility | Contract |
|---------|----------|
| `app-frame` | `h-svh max-h-svh overflow-hidden` — one screen, no page scroll |
| `app-scroll` | `flex-1 min-h-0 overflow-y-auto overscroll-y-contain` — designated scroll region |
| `main-pane` | `min-w-0 max-w-full overflow-x-hidden` — flex shrink boundary (shell inset, columns) |
| `home-column` | `main-pane` + `max-w-home` (45rem) + `px-8 py-16` + flex column |
| `chat-column` | `main-pane` + `max-w-chat-column` (48rem) + `px-8` |
| `chat-scroll-fade-bottom` | bottom scrollport mask when a pinned composer is present |

**Boundary chain:** `html/body` → `app-frame` → `app-scroll` → column utilities → `prose-tokens` / `user-turn`. Do not sprinkle `min-w-0` on turn leaves; exceptions only on truncating flex children (`disclosure-trigger`, sidebar rename field).

Other notable Tier-2 utilities: `user-message-bubble` (asymmetric radius), `prose-tokens` (markdown overflow contract), `focus-ring` (single focus treatment), `streaming-dot` (motion + status tokens).

### Dark mode seam

Only light tokens ship today. Future `.dark` values override the same theme variable names; components stay unchanged because they consume tokens, not literals.

---

## 2. OSS patterns that align

### Documenso — closest shadcn cousin

- **File split:** shared `packages/ui/styles/theme.css` (CSS vars) + `@documenso/tailwind-config` (Tailwind v3 `theme.extend`).
- **Semantic layer:** shadcn HSL components (`--background: 0 0% 100%`) consumed as `hsl(var(--color-background))` in config.
- **Primitive layer:** parallel `--new-primary-50` … `--new-neutral-950` scales alongside semantics — useful for one-off tints but adds naming surface.
- **Aligns with Meridian Flow:** semantic-first consumption in components; shared package for theme CSS; app imports theme then adds fonts/overrides.
- **Differs:** Tailwind v3 config extension vs Meridian Flow's v4 `@theme`; HSL storage vs hex; no `@utility` tier — repeated stacks live in component classes or `@layer components`.

### Cal.com coss-ui — closest Tailwind v4 cousin

- **Single file:** `globals.css` holds `@theme inline`, `:root` semantics, `.dark` overrides, `@layer base` — same structural pattern as Meridian Flow.
- **Two-step semantics:** `:root` semantic vars reference Tailwind v4 color primitives (`--foreground: var(--color-neutral-800)`) rather than raw hex.
- **Aligns with Meridian Flow:** `@theme` source, shadcn role names, sidebar/chart tokens, derived `--radius-*`.
- **Differs:** no separate design-tokens package; no Tier-2 `@utility` shell primitives; uses `--alpha()` and `color-mix()` heavily for borders/muted fills.

### Twenty — enterprise primitive palette

- **Source of truth:** TypeScript constants in `packages/twenty-ui/src/theme/constants/` → **generated** `theme-light.css` / `theme-dark.css` (do not hand-edit).
- **Naming:** `--t-` prefix; semantic aliases (`--t-background-primary`) sit atop Radix-style 12-step scales per hue (`--t-color-green1` … `--t-color-green12`).
- **Consumption:** styled-components/emotion read CSS vars directly; **no Tailwind `@theme`**.
- **Aligns with Meridian Flow:** strict semantic aliases for components; light/dark as separate generated files; motion/spacing/icon tokens centralized.
- **Differs:** massive primitive layer (1000+ vars) vs Meridian Flow's flat semantic set (~70 vars); codegen pipeline; no utility tier.

### Summary matrix

| Pattern | Meridian Flow | Documenso | coss-ui | Twenty |
|---------|--------|-----------|---------|--------|
| CSS vars as source | ✓ hex | ✓ HSL | ✓ mixed | ✓ P3/hex |
| Tailwind bridge | `@theme inline` v4 | `tailwind.config` v3 | `@theme inline` v4 | none |
| Shared package split | `design-tokens` pkg | `ui/styles` pkg | in-package CSS | `twenty-ui` pkg |
| Primitive scales | minimal (by design) | `--new-*` scales | Tailwind color refs | Radix 12-step |
| Composite utilities | `@utility` Tier 2 | component classes | none | styled wrappers |
| Codegen | none | none | none | TS → CSS |

Meridian Flow's model is **Documenso semantics + coss-ui Tailwind v4 bridge + a explicit utility tier Twenty lacks**.

---

## 3. What closed-source products hide

Browser DevTools reveal **computed values**, not architecture. Sampling on 2026-06-05 (welcome/login surfaces — not authenticated app chrome):

### Notion (observed runtime values, not source architecture)

URL: `notion.so/chat` welcome page.

| Element | background | text | border-radius |
|---------|------------|------|---------------|
| `body` | transparent | `rgb(0,0,0)` | 0 |
| first `button` | `rgb(0,0,0)` | `rgb(44,44,43)` | **20px** |

Cannot infer: token file layout, semantic vs primitive split, promotion rules, dark mode strategy.

### Figma (observed runtime values, not source architecture)

URL: `figma.com/files` home (pre-auth shell).

| Element | background | text | border-radius |
|---------|------------|------|---------------|
| `body` | `rgb(255,255,255)` | `rgb(0,0,0)` | 0 |
| first `button` | transparent | `rgb(0,0,0)` | **4px** (font-size 11px) |

Cannot infer: design-system package boundaries, whether radii are tokenized, utility vs component class split.

**General blind spots for closed-source UI:** naming conventions, tier/promotion policy, shared-vs-app token split, and whether `@utility`/CSS-module/component-library owns composite patterns.

---

## 4. Recommendations for Warm Paper token discipline

1. **Keep the three-file split.** Shared palette stays in `@meridian/design-tokens`; never add `@utility` or `@theme` there. Project-only vars (`--chat-scroll-fade-size`, `--answer-max-width`) stay in `globals.css` `:root` until a second surface (`@meridian/web`) needs them — then promote to the package.

2. **Resist primitive scales.** Twenty and Documenso's `--new-primary-50` ladders are powerful but costly to maintain. Warm Paper's flat semantic set matches the product's constrained palette; add a scale only when ≥3 distinct steps of the same hue are needed in production (e.g. a data-viz series).

3. **Bridge once in `@theme`.** Follow coss-ui/Meridian Flow pattern: components use Tailwind classes only. If a var needs a class, map it in `@theme inline` — do not reference `--background` directly in TSX `style={{}}`.

4. **Enforce promotion at review time.** Grep touched files for `#hex`, `rgba(`, `rounded-[`, `text-[Npx]`, `gap-[Npx]`. Each hit is either (a) genuinely unique geometry (user-bubble asymmetric radius) or (b) a promotion candidate.

5. **Sync DESIGN.md YAML after token edits.** CSS is canonical; YAML front matter is a lint/export mirror — update it when adding/removing tokens, not as the edit source.

6. **Prepare dark mode as token overrides only.** When shipping dark, add `.dark { --background: …; … }` in `warm-paper.css` or `globals.css` — no `dark:` class sprawl in feature TSX.

7. **Document new Tier-2 utilities in DESIGN.md § Components.** The table is the inventory; `@utility` name must match the doc row.

---

## 5. Code organization rules

### Where tokens live

| Need | Location |
|------|----------|
| Color/shadow/status shared across app + web | `packages/design-tokens/src/warm-paper.css` |
| Type scale, container widths, radius derivatives | `apps/app/src/styles/globals.css` `@theme inline` |
| Project-only computed vars (fade gradients) | `apps/app/src/styles/globals.css` `:root` |
| Human-readable role descriptions | `DESIGN.md` (repo root) |
| Implementation contract (tiers, overflow chain) | `apps/app/.context/CONTEXT.md` |

### When to add `@utility` vs component class vs inline Tailwind

| Situation | Action |
|-----------|--------|
| Stack uses ≥2 semantic tokens and repeats ≥2 places | **`@utility`** in `globals.css` |
| Single-purpose geometry unique to one component | **Inline Tailwind** (Tier 3) in TSX |
| shadcn `components/ui/*` default styling | **`cn()` + token classes at call site** — do not hand-edit ui sources |
| Focus, sr-only, prose, shell boundaries | **Always `@utility`** (`focus-ring`, `visually-hidden`, `prose-tokens`, `app-frame`) |
| Layout wrapper with no extra logic | **Thin component** that applies one `@utility` (`<div className="chat-column">`) |

### When *not* to add tokens

- One-off marketing hero layout on a single route
- Component-internal padding that no sibling needs to match
- Temporary prototype routes (`/test/*`) — but do not merge magic pixels to production

### Import order in app styles

```css
@import "@meridian/design-tokens/warm-paper.css";
@import "tailwindcss";
/* then @theme, :root overrides, @layer base, @utility */
```

---

## Blockers

| Blocker | Impact |
|---------|--------|
| No authenticated Notion/Figma session in browser | Part C samples are welcome-page shells only — not representative of in-app token architecture |
| cal-com full app theme not read | coss-ui `globals.css` sampled; main Cal.com app may add layers |
| Dark mode not implemented | Recommendations are seam-prep only; no verified `.dark` override set |
| `@meridian/web` parity unchecked | Assumption: web imports same `warm-paper.css`; verify before promoting project vars to package |

---

## Related

- [DESIGN.md](../../../DESIGN.md) — Warm Paper human spec
- [CONTEXT.md](../../CONTEXT.md) § Visual conventions — tier model, overflow chain
- [source-app-shell-patterns.md](../../source-app-shell-patterns.md) — OSS shell comparison
- [packages/design-tokens/AGENTS.md](../../../../packages/design-tokens/AGENTS.md) — package boundary
