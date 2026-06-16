# Brand / Design Language

## Color

- **Light mode (default):** Paper `#F6F2EA` background, near-black `#1F1A12` text
- **Dark mode:** Espresso `#1C1917` background, warm cream `#F0EBE3` text
- **Primary accent:** Jade-Teal `#1A8B7A` (light), `#40C8B0` (dark)
- **Accent usage:** Constrain to non-text uses (icons, borders, fills). For text on accent or accent as text, use a darker variant that passes WCAG AA (4.5:1+). Current `#1A8B7A` on paper is 3.75:1 — fails AA for normal text.
- **Links:** Browser default (blue)
- **Text selection:** Browser default
- **Semantic colors (fixed):** Accept green, reject red, pending amber — unchanged

## Typography

- **Editor:** iA Writer Quattro
- **UI:** Geist
- **Code:** Geist Mono
- **Editor column:** 68ch (iA Writer standard)

## Icons

- Phosphor Icons (6 weights, good writing coverage)
- Note: existing frontend uses Lucide — migration needed

## Philosophy

- Prefer browser/system defaults unless there's a strong reason to override
- "Serious creative tool" positioning — not playful, not corporate
- Cultivation/xianxia origin is an Easter egg, not marketing copy
- Paper aesthetic is the differentiator in the market

## WCAG Contrast (verified)

| Pairing | Ratio | WCAG AA |
|---------|-------|---------|
| Near-black on paper | 15.48:1 | Pass |
| Cream on espresso | 14.74:1 | Pass |
| Browser blue on paper | 8.42:1 | Pass |
| Teal `#1A8B7A` on paper | 3.75:1 | **Fail** (text) |
| White on teal | 4.18:1 | **Fail** (text) |
