---
title: Meridian UI Design System — Color and Shadow
description: Color palette, roles, state colors, and elevation/shadow specs for Meridian (Jade & Gold hybrid light mode + refined dark mode)
created_at: 2025-11-16
updated_at: 2025-11-16
author: Meridian Design Team
category: design
tracked: true
---

# Meridian Design System: Color and Shadow

This document specifies only color and shadow. It captures the inspiration, purpose of the palette choices, and how light/dark themes apply across surfaces and states.

---

## 1) Inspiration and Intent

- Jade evokes flow, balance, and cultivated focus — the “meridian” of ideas.
- Gold implies insight, value, and small moments of illumination.
- Parchment grounds the interface in a writer’s craft — warm, legible, and calm.
- Dark mode is not pure black: it’s green‑black jade to preserve depth and reduce glare.

Goal: a quiet canvas where content leads, with restrained highlights guiding attention.

---

## 2) Core Palette (Base Tokens)

Light Mode (Hybrid)
- Jade 900 (anchor sidebar): #2F7F72
- Jade 300 (muted sidebar base/alt): #A9BDB5
- Parchment 50 (app background): #F7F3EB
- Parchment 0 (pure surface): #FFFFFF
- Ink 900 (text/ink): #1C1A18
- Gold 500 (accent): #F4B41A
- Line 200 (borders): #DDD6C8
- Neutral 100 (subtle fills): #F2EFE8

Dark Mode (Refined, hint of green)
- Jade Black (base): #1B2421
- Jade 800 (surfaces): #202622
- Slate 700 (alt surface): #242A27
- Ink 50 (text on dark): #EAEAE7
- Gold 400 (accent on dark): #E3C169
- Line 800 (borders): #2E332F
- Glow Jade (focus rim): #3CC8B4 (used sparingly, low opacity)

Notes:
- Gold is a highlight, not a brand flood color.
- Parchment tones prevent cold sterility in light mode.

---

## 3) Semantic Roles (By Area)

Left Sidebar (Navigation + Logo + Profile)
- Light: background #A9BDB5, content #F7F3EB, icons #2F7F72, active marker #F4B41A
- Dark: background #1B2421, content #EAEAE7, icons #EAEAE7, active marker #E3C169

Center Chat (Conversation Surface)
- Light: background #F7F3EB, user bubble fill #FFFFFF, AI bubble border #2F7F72 on white/parchment, timestamps #8A7F6C
- Dark: background #202622, user bubble fill #242A27, AI bubble rim #3CC8B4 at low alpha over #242A27, timestamps #B6B0A2

Right Panel (Documents / Explorer)
- Light: background #F7F3EB → cards #FFFFFF, active item text #2F7F72, highlight line #F4B41A
- Dark: background #202622 → panels #1B2421, active item text #EAEAE7, highlight line #E3C169

Top Elements (Badges, Tags, Subtle CTAs)
- Light: text/icons ink #1C1A18, accents #2F7F72, rare gold #F4B41A
- Dark: text/icons #EAEAE7, accents #B7D4CC (jade tint), rare gold #E3C169

---

## 4) States and Interaction Colors

Focus
- Light: outline jade #2F7F72 at 24–32% opacity; optional gold inner ring #F4B41A at ~16% for primary inputs
- Dark: outline cyan‑jade #3CC8B4 at 18–24%; optional gold inner ring #E3C169 at ~12%

Hover
- Light: elevate with subtle shadow (see Shadows), tint fill toward Jade 300 (#A9BDB5) at 6–8%
- Dark: elevate, tint toward Jade 800 (#202622 → #25302C) at 6–8%

Active/Selected
- Light: left border or pill underline in Gold 500 (#F4B41A); background stays neutral
- Dark: same pattern with Gold 400 (#E3C169); avoid full gold fills

Disabled
- Light: lower contrast ink (#9A958A), reduce border contrast (Line 200 at 60%)
- Dark: reduce to #7E857F text and Line 800 at 60%

Error/Warning (toned warm, not aggressive)
- Light: amber‑clay #EBA868 (text/icons), background wash #FDF3E6
- Dark: amber #E0A15F, background wash #2A2620

Info/Success (muted jade)
- Light: jade #2F7F72 on soft wash #EBF5F2
- Dark: jade glow #3CC8B4 on wash #1E2724

---

## 5) Shadow and Elevation

Philosophy: soft, book‑like depth; avoid harsh, high‑spread shadows. Use layered translucency over theme surfaces.

Light Mode Shadows (on parchment or white)
- Level 1 (cards, bubbles idle):
  - rgba(28, 26, 24, 0.06) 0px 1px 2px
  - rgba(28, 26, 24, 0.04) 0px 2px 6px
- Level 2 (hover, active tiles):
  - rgba(28, 26, 24, 0.10) 0px 3px 8px
  - rgba(28, 26, 24, 0.06) 0px 6px 16px
- Level 3 (modals, sticky bars):
  - rgba(28, 26, 24, 0.18) 0px 8px 24px
  - rgba(28, 26, 24, 0.10) 0px 12px 32px

Dark Mode Shadows (on jade‑black)
- Level 1:
  - rgba(0, 0, 0, 0.30) 0px 1px 2px
  - rgba(60, 200, 180, 0.10) 0px 0px 0px 1px inset (subtle jade edge on focusable elements)
- Level 2:
  - rgba(0, 0, 0, 0.45) 0px 3px 10px
  - rgba(227, 193, 105, 0.10) 0px 0px 0px 1px inset (gold hint for active)
- Level 3:
  - rgba(0, 0, 0, 0.60) 0px 8px 28px
  - optional outer glow: rgba(60, 200, 180, 0.12) 0px 0px 24px (for standout prompts)

Note: prefer subtle inner strokes (inset) to outlines for dark mode clarity.

---

## 6) Component Color Application (No sizes implied)

Sidebar
- Light: bg #A9BDB5; item text #F7F3EB; hover wash #BCD1CA; selected marker #F4B41A
- Dark: bg #1B2421; item text #EAEAE7; hover wash #25302C; selected marker #E3C169

Chat Bubbles
- Light: user fill #FFFFFF, border #DDD6C8; AI border #2F7F72 on white/parchment; code/inline blocks background #F2EFE8
- Dark: user fill #242A27, border #2E332F; AI rim #3CC8B4 at low alpha; code/inline blocks background #1B2421

Inputs (message bar, search)
- Light: fill #FFFFFF; border default #DDD6C8; focus ring jade #2F7F72 (26%) + inner gold #F4B41A (12%)
- Dark: fill #1B2421; border #2E332F; focus ring #3CC8B4 (22%) + inner #E3C169 (10%)

Buttons
- Primary (confirm/CTA):
  - Light: fill jade #2F7F72; text #FFFFFF; hover shade toward #2A6E64; focus ring jade/gold
  - Dark: outline gold #E3C169 on jade‑black; text #EAEAE7; hover fill rgba(227, 193, 105, 0.08)
- Secondary:
  - Light: outline jade #2F7F72; text ink #1C1A18; hover wash #EBF5F2
  - Dark: outline #B7D4CC; text #EAEAE7; hover wash #22302A

Highlights and Badges
- Light: gold text/icon #F4B41A on neutral #FFF9E4
- Dark: gold #E3C169 on #2A2B26; optional jade halo rgba(60,200,180,0.10)

Dividers
- Light: #DDD6C8 at 80% opacity
- Dark: #2E332F at 80% opacity

---

## 7) Accessibility and Contrast Guidance

- Target 4.5:1 contrast for text vs background (Ink 900 on Parchment 50; Ink 50 on Jade Black/Jade 800).
- Gold is reserved for marks/indicators; avoid gold on parchment for body text.
- Provide high‑contrast mode by increasing Ink and Line opacity + removing soft tints.

---

## 8) Thematic Mapping (Why these colors)

- Jade = flow of context, steady intelligence, cultivated craft.
- Gold = insight moments, selection, and orientation cues.
- Parchment = writer’s page; protects eyes over long sessions.
- Green‑black dark = night focus, low glare, retains depth with a living hue.

This palette keeps Meridian recognizable and calm, while ensuring interactions are discoverable through restrained glow and shadow.

---