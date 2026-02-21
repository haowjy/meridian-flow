# Cleanup 001: Incorrect CSS var() claim — baseTheme DOES support custom properties

**Category:** Correctness
**File:** `_docs/designs/inline-review-v2.md` (line 502)
**Severity:** Medium — factual error that could mislead implementation decisions

## What's Wrong

The design states:
> **Why move to globals.css**: The `EditorView.baseTheme()` approach doesn't support `var()` CSS custom properties (they resolve at paint time, but baseTheme compiles to static styles).

This is **factually incorrect**. `baseTheme()` generates real CSS rules injected into a `<style>` tag via the `style-mod` library's `StyleModule`. CSS `var()` custom properties work perfectly in these rules — the browser resolves them at paint time from the real CSS cascade.

**Proof**: The project's own `livePreviewTheme` in `frontend/src/core/editor/codemirror/extensions/theme.ts` extensively uses `var()` inside `EditorView.theme()`, which uses the **identical** `buildTheme()` + `StyleModule` mechanism as `baseTheme()`. Examples at lines 38, 58, 68, 90, 92, and 10+ more.

## Why It Matters

1. Future developers reading this doc will believe `baseTheme()` can't use CSS variables — wasting time on workarounds
2. The **real** motivation for moving to globals.css (consistency with the project's approach, centralized theme management) is valid but mischaracterized
3. If the migration is deferred, developers might avoid `var()` in baseTheme unnecessarily

## Suggested Fix

Replace the "Why move to globals.css" paragraph with:
> **Why move to globals.css**: Centralizes review styles alongside the project's other editor styles. Enables consistent management of theme tokens (`var(--success)`, `var(--error)`) in one file rather than spreading them across inline JS theme objects. Matches the project's pattern of using globals.css for cross-component styles.

Note: `baseTheme()` _does_ support `var()` — the migration is a consistency/maintainability choice, not a technical necessity.
