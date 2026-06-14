# Prose Analysis

Client-side text analysis for fiction writing. No LLM cost — runs entirely in the browser.

## Scope

- **Sentence length distribution** — highlight overly long sentences
- **Passive voice detection** — flag passive constructions
- **Adverb density** — highlight adverb-heavy passages
- **Readability score** — Flesch-Kincaid or similar
- **Repetition detection** — repeated words/phrases within proximity

## Implementation

- Pure client-side — no server calls, no credits consumed
- Toggle on/off per document (not always-on)
- Results as CM6 decorations (underlines, highlights with tooltips)
- Summary panel with aggregate stats

## Design Notes

- This is a differentiator — most AI writing tools charge for analysis. Meridian does it free client-side.
- Keep it subtle — decorations should inform, not distract from writing flow
- Writer can dismiss individual highlights

## Future (post-v1)

- Custom analysis rules (user-defined patterns to flag)
- AI-powered analysis (voice consistency, pacing, tension curves) — this would use credits
- Per-chapter comparison

## Dependencies

- CM6 shared extensions (decoration layer)
- Design system (analysis panel, tooltip styles)
