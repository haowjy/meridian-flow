# VS Code-style custom themes — feasibility for Meridian Flow

Source-context research: VS Code shallow-cloned to `~/.meridian/ref/vscode`; Meridian Flow tokens read from `packages/design-tokens/src/warm-paper.css` and `apps/app/src/styles/globals.css`. OSS comparables skimmed: Twenty, Documenso (Lobe Chat uses antd-style + next-themes — preset light/dark only).

**Verdict: M (medium)** for a useful VS Code-*like* custom palette changer on top of Meridian Flow's existing CSS token model. **S** for light/dark + a few curated presets. **L** if the goal is VS Code parity (TextMate scopes, extension themes, syntax engine).

---

## How VS Code does it (evidence paths)

### Theme file format

Color themes are JSON (legacy `.tmTheme` plist still supported). Canonical example:

| Path | Role |
|------|------|
| `extensions/theme-defaults/package.json` | `contributes.themes[]` registry |
| `extensions/theme-defaults/themes/dark_modern.json` | Project `colors` map |
| `extensions/theme-defaults/themes/dark_plus.json` | `tokenColors` (syntax) + `include` chain |

Structure:

```json
{
  "$schema": "vscode://schemas/color-theme",
  "name": "Dark Modern",
  "include": "./dark_plus.json",
  "colors": { "editor.background": "#1F1F1F", "activityBar.background": "#181818", … },
  "tokenColors": [ { "scope": ["entity.name.function"], "settings": { "foreground": "#DCDCAA" } } ],
  "semanticHighlighting": true,
  "semanticTokenColors": { … }
}
```

Three parallel color systems:

| Layer | Keys | Consumed by |
|-------|------|-------------|
| **Project colors** | Dotted IDs (`editor.background`, `sideBar.foreground`, `button.background`) | UI via CSS variables |
| **Token colors** | TextMate scopes (`keyword`, `entity.name.function`, …) | Monaco editor tokenizer |
| **Semantic token colors** | Language-server classifiers (`function.declaration`, `variable.readonly`) | Editor semantic highlighting |

Themes compose via `"include"` — child file merges over parent (`colorThemeData.ts` → `_loadColorTheme`).

### Extension API

`src/vs/project/services/themes/common/themeExtensionPoints.ts`:

```ts
contributes.themes: [{
  id: string,       // used in settings
  label: string,    // picker label
  uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light',
  path: string      // relative JSON path
}]
```

`uiTheme` selects base scheme class on the project root and drives registry default resolution (light vs dark vs high-contrast).

### Token registry + mapping to CSS

VS Code does **not** map theme JSON directly to component CSS. There is a registry layer:

| Piece | Path | Role |
|-------|------|------|
| Color registry | `src/vs/platform/theme/common/colorRegistry.ts`, `colorUtils.ts`, `colors/*.ts` | ~**253** `registerColor()` entries, each with `light`/`dark`/`hcDark`/`hcLight` defaults |
| CSS var naming | `asCssVariableName()` in `colorUtils.ts` | `editor.background` → `--vscode-editor-background` |
| Theme resolution | `colorThemeData.ts` → `getColor()` | **custom** → **theme file** → **registry default** |
| CSS emission | `browser/colorThemeCss.ts` → `generateColorThemeCSS()` | Iterates registry, emits all resolved colors as vars on `.monaco-project { … }` |
| Runtime apply | `browser/projectThemeService.ts` → `applyTheme()` | Injects `<style>` sheet, toggles `vs`/`vs-dark`/`hc-*` classes |

Components and Monaco theming participants read `var(--vscode-*)` or call `theme.getColor('editor.background')`.

### Runtime load / switch

Flow in `projectThemeService.ts`:

1. **Boot** — hydrate last theme from storage (`ColorThemeData.fromStorageData`) or apply initial color map to avoid flash.
2. **Registry** — scan extension manifests → `ThemeRegistry` of `ColorThemeData` stubs.
3. **Select** — `setColorTheme(id)` → `ensureLoaded()` (fetch JSON, resolve `include` chain) → `setCustomizations(settings)`.
4. **Apply** — `generateColorThemeCSS()` → `_applyRules()` into DOM → `classList` swap → fire `onDidColorThemeChange`.
5. **React** — configuration listener reloads when `project.colorCustomizations` changes.

Settings in `themeConfiguration.ts`: `project.colorTheme`, `window.autoDetectColorScheme`, preferred dark/light/HC themes.

### User customization

Three settings objects (schemas generated from registries):

| Setting | Overrides |
|---------|-----------|
| `project.colorCustomizations` | Project color IDs; supports theme-scoped keys like `"[Dark Modern]": { "editor.background": "#000" }` |
| `editor.tokenColorCustomizations` | TextMate rules + shortcut groups (`comments`, `strings`, `keywords`, …) |
| `editor.semanticTokenColorCustomizations` | Semantic token rules |

Merged in `ColorThemeData.setCustomizations()` — custom layer wins over theme file over registry defaults.

### Dark / light / high contrast

Four schemes (`ThemeTypeSelector`): `vs`, `vs-dark`, `hc-black`, `hc-light`. Each registered color has per-scheme defaults. `window.autoDetectColorScheme` swaps between preferred light/dark themes. HC is a separate accessibility track with its own preferred themes.

---

## Convergent patterns worth adopting

| Pattern | VS Code | Meridian Flow fit |
|---------|---------|------------|
| **Semantic token IDs, not hex in components** | `registerColor('sideBar.background')` | Already: `--background`, `--sidebar`, Tailwind `bg-card` |
| **Runtime = CSS custom properties** | `--vscode-*` injected on root scope | Already: `:root` in `warm-paper.css` + `@theme inline` bridge |
| **Theme swap = class + var override** | `.monaco-project.vs-dark` + regenerated vars | Planned: `.dark { --background: … }` on `html` (`globals.css` `@custom-variant dark`) |
| **Preset themes as data files** | JSON `colors` maps | Could be JSON → apply to `:root` without VS Code's registry |
| **User overrides as a patch object** | `project.colorCustomizations` | `localStorage` patch merged over active preset |
| **Inheritance** | `"include": "./base.json"` | Useful for "Warm Paper Dark extends Warm Paper" |

OSS apps converge on the same runtime mechanism:

- **Twenty** (`twenty-ui/.../ThemeProvider.tsx`): toggles `.dark`/`.light` on `documentElement`; reads computed CSS vars into React context.
- **Documenso** (`packages/ui/styles/theme.css`): `:root` + `.dark` HSL vars; `theme-switcher.tsx` flips scheme via hook.
- **Lobe Chat**: `next-themes` + antd-style — light/dark/system only, no user palette JSON.

None of these expose VS Code-grade per-token project customization; they stop at scheme switching.

---

## Divergent / VS Code-specific (don't copy)

| VS Code capability | Why skip or defer |
|--------------------|-------------------|
| **~253 project color IDs** | Meridian Flow has **~64** semantic vars; 4× smaller surface, shadcn-shaped |
| **TextMate `tokenColors` + scope matcher** | Meridian Flow uses Shiki in `Markdown.tsx` (`github-light` / `github-dark` hardcoded) — separate pipeline |
| **Semantic token colorization** | Requires LSP-classified tokens in an editor surface Meridian Flow doesn't have yet |
| **Extension `contributes.themes` + marketplace** | No extension host; ship presets as app assets or user JSON upload |
| **File icon + product icon themes** | Out of scope for palette changer |
| **Color registry with derived transforms** (`darken`, `transparent`, `ifDefinedThenElse`) | Meridian Flow uses pre-resolved hex/rgba in CSS; derived shadows/gradients are hand-authored |
| **4-way HC track** | Defer; start with light/dark (+ system preference) |
| **Settings sync / profile storage** | Meridian Flow has no user settings service yet |

---

## Meridian Flow gap analysis (current token model vs what's needed)

### What Meridian Flow already has

```
packages/design-tokens/src/warm-paper.css   ← ~64 semantic hex vars (:root)
apps/app/src/styles/globals.css
  ├─ @theme inline          ← Tailwind bridge (--color-*)
  ├─ :root project-only   ← composer fade, answer max-width
  ├─ @custom-variant dark   ← seam exists, no .dark values yet
  └─ @utility …             ← composites (surface-card, prose-tokens, …)
```

Components consume Tailwind classes (`bg-surface-subtle`, `text-ink-muted`) — correct for theme swapping.

### Gaps for custom themes

| Gap | Severity | Notes |
|-----|----------|-------|
| **No `.dark` (or alternate) value set** | Blocker for any scheme switching | Documented seam, not implemented |
| **`dark:` variants in ui primitives** | Medium | `button.tsx`, `input.tsx`, etc. use `dark:bg-input/30` — fights "override tokens only" policy |
| **Derived tokens with fixed hue** | Medium | `--shadow-card`, `--shadow-button`, `--status-streaming-ring` embed `rgba(16,33,28,…)` / `rgba(29,107,87,…)`; custom primary won't propagate |
| **Chat scroll fade mask** | Low | `--chat-scroll-fade-size` masks scroll content at the bottom; independent of theme background color |
| **Shiki decoupled from app palette** | Medium | `Markdown.tsx` hardcodes `github-light`/`github-dark`; custom theme won't recolor code blocks |
| **No runtime theme state** | Medium | No `ThemeProvider`, no `localStorage`/profile persistence |
| **No validation** | Low–medium | User hex can break contrast; VS Code doesn't enforce either, but product may want guardrails |
| **Canonical CSS decision** | Constraint | User themes should remain CSS-var-based; JSON is an *authoring* format, not a second runtime source of truth |

### Mapping VS Code concepts → Meridian Flow tokens

| VS Code project key | Meridian Flow equivalent (approx.) |
|-----------------------|----------------------------|
| `foreground` / `editor.foreground` | `--color-foreground`, `--color-answer-foreground`, `--color-ink-*` |
| `editor.background` | `--color-background`, `--color-surface-*`, `--color-card` |
| `sideBar.*` | `--color-sidebar-*` |
| `button.background` | `--color-primary` |
| `input.background` | `--color-input`, `--color-muted` |
| `focusBorder` | `--color-ring`, `--color-border-focus` |
| `errorForeground` | `--color-destructive` |
| *(no VS Code equivalent)* | `--color-chip-*`, `--color-status-streaming`, `--background-image-gradient-*`, type scale in `@theme` |

A Meridian Flow theme JSON needs **~40–50 color keys** (not 253) if shadows/gradients are either omitted from v1 or generated from a small set of anchors.

---

## Difficulty estimate (S/M/L) with phases

| Scope | Size | Effort (honest) |
|-------|------|-----------------|
| **Phase 0 — Dark mode** | **S** | 2–4 days: `.dark { … }` block mirroring `:root`, remove `dark:` sprawl from ui primitives, wire Shiki to scheme |
| **Phase 1 — Scheme toggle** | **S** | 1–2 days: `ThemeProvider` (Twenty/Documenso pattern), `localStorage`, system preference, class on `<html>` |
| **Phase 2 — Curated presets** | **S** | 2–3 days: 2–3 named themes as CSS files or JSON assets (e.g. Warm Paper, Slate, High-contrast); picker UI |
| **Phase 3 — User custom palette** | **M** | 1–2 weeks: JSON schema for Meridian Flow token keys, import/apply via `document.documentElement.style.setProperty`, override patch in `localStorage`, basic settings panel |
| **Phase 4 — VS Code theme import** | **M–L** | 1–3 weeks: map subset of `project.colorCustomizations` keys → Meridian Flow vars; ignore tokenColors; heuristic mapping table |
| **Full VS Code parity** | **L** | Months — don't pursue |

**Overall for "VS Code-like custom color palette / theme changer" aligned with Meridian Flow architecture: M** — mostly because Phase 0 (dark) is prerequisite and derived tokens need a strategy before user palettes look coherent.

---

## Recommended approach for Meridian Flow (minimal viable theme changer)

Combine **Option A + C**, with **Option B** as the authoring format — not a second runtime.

### Option A — CSS var swap (primary runtime) ✓

```ts
// Pseudocode — matches Twenty/Documenso
function applyTheme(vars: Record<string, string>) {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(vars)) {
    root.style.setProperty(`--${token}`, value);
  }
}
```

- Presets ship as complete var maps (from CSS files at build time or JSON fetched at runtime).
- Revert custom theme: `root.style.removeProperty('--background')` for each key, or swap `<link>` / swap `data-theme="warm-paper"` class that scopes a second `:root` block.
- Prefer **`[data-theme="…"]` or `.theme-*` on `<html>`** over inline styles for presets (cacheable, no FOUC); reserve inline/`setProperty` for user *overrides* only.

### Option B — Theme JSON (authoring, optional) ✓

Meridian Flow-flavored schema (not VS Code's):

```json
{
  "name": "My Lab Palette",
  "type": "dark",
  "colors": {
    "background": "#0f1412",
    "foreground": "#e8f0ec",
    "primary": "#3d9e82",
    "sidebar": "#141a18"
  },
  "include": "warm-paper-dark"
}
```

- Validate against allowlisted keys (the vars in `warm-paper.css`).
- Load → merge with base → call `applyTheme()`.
- Do **not** duplicate YAML in DESIGN.md; JSON schema can live beside `warm-paper.css` as machine docs.

### Option C — In-app picker + localStorage ✓

- Settings → Appearance: Light / Dark / System + Preset dropdown + "Customize…" (advanced: color pickers for ~12 anchor tokens).
- Persist: `{ presetId, mode, overrides }` in `localStorage` (v1); later user profile API.
- On boot: blocking script in root layout (or `useLayoutEffect`) applies before paint — copy VS Code's "initial color map" pattern to avoid flash.

### Minimal viable sequence

1. **Ship `.dark` overrides** in `warm-paper.css` (or `themes/warm-paper-dark.css` imported under `.dark`).
2. **`ThemeProvider`** + toggle; fix ui `dark:` classes to token-only.
3. **2 presets** (Warm Paper light/dark) — proves picker.
4. **Override patch** for ~8 anchors: `background`, `foreground`, `primary`, `card`, `border`, `muted`, `destructive`, `sidebar`.
5. **Derive shadows** from anchors in apply step (simple: replace alpha channel hue) or exclude from v1 customization.
6. **Shiki**: pass theme keyed off `colorScheme` or generate from `--background`/`--foreground`.

---

## Blockers / open questions

| # | Blocker / question | Owner decision |
|---|-------------------|----------------|
| 1 | **Dark mode first?** Custom themes without a dark base doubles design work. | Ship Phase 0 before palette customization |
| 2 | **Derived tokens** — require full explicit maps per theme, or runtime derivation (hsl/relative color)? | Affects JSON schema size and visual quality |
| 3 | **Shiki / code blocks** — stay on GitHub themes, map from app palette, or user-selectable? | Affects "VS Code-like" feel in chat |
| 4 | **Persistence** — `localStorage` only vs account settings? | Cross-device sync |
| 5 | **Contrast / a11y** — warn on WCAG fail, block apply, or trust user? | Product policy |
| 6 | **VS Code theme import** — desired for researchers who already have dotfiles? | Optional Phase 4; needs mapping table maintenance |
| 7 | **`dark:` in ui primitives** — refactor now as part of theme work? | Aligns with AGENTS.md "no dark-specific classnames" |
| 8 | **Marketing (`apps/web`)** — share `@meridian/design-tokens` presets or app-only? | Scope boundary |

---

## Top 3 findings

1. **VS Code's real mechanism is "registry + CSS vars," not magic** — themes are JSON patches over ~253 registered IDs; runtime injects `--vscode-*` on a root class. Meridian Flow's `:root` semantic vars are the same idea with a much smaller, shadcn-shaped surface (~64 keys). **Adopting the runtime pattern is easy; adopting the schema breadth is not.**

2. **VS Code splits project colors from syntax token colors** — two pipelines (CSS vars vs TextMate/semantic). Meridian Flow's UI can theme-swap with CSS alone; markdown/code highlighting is a **separate** Shiki decision and blocks "full IDE theme" parity.

3. **OSS apps stop at light/dark/system** — Twenty and Documenso toggle a class and override the same var names. User-defined palettes are an incremental step (JSON → `setProperty` or extra CSS files), not a rewrite. **M effort** is mostly derived-token coherence and UX, not architecture.

---

## Sources

| Source | Path |
|--------|------|
| VS Code theme service | `~/.meridian/ref/vscode/src/vs/project/services/themes/browser/projectThemeService.ts` |
| VS Code theme data / load | `~/.meridian/ref/vscode/src/vs/project/services/themes/common/colorThemeData.ts` |
| VS Code CSS generation | `~/.meridian/ref/vscode/src/vs/project/services/themes/browser/colorThemeCss.ts` |
| VS Code color registry | `~/.meridian/ref/vscode/src/vs/platform/theme/common/colorUtils.ts`, `colors/*.ts` |
| VS Code extension point | `~/.meridian/ref/vscode/src/vs/project/services/themes/common/themeExtensionPoints.ts` |
| VS Code default themes | `~/.meridian/ref/vscode/extensions/theme-defaults/` |
| Meridian Flow tokens | `packages/design-tokens/src/warm-paper.css`, `apps/app/src/styles/globals.css` |
| Meridian Flow token review | `apps/app/.context/best-practices/live-reviews/tokens-css-org.md` |
| Twenty | `~/.meridian/ref/twenty/packages/twenty-ui/src/theme-constants/ThemeProvider.tsx` |
| Documenso | `~/.meridian/ref/documenso/packages/ui/styles/theme.css`, `theme-switcher.tsx` |
