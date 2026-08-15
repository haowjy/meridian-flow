# Work card spacing evidence

## Before

Source: [`../desktop-work.png`](../desktop-work.png) at 1440 × 840 and the pre-change
card classes at `1a1b28705`.

- Card bounds: 368 × 144 px (`min-h-36`), from x=296..664 and y=196..340.
- Outer padding declaration: 16 px (`p-4`), with the menu beginning on that top/right inset.
- The stretched selection control vertically centered its two text lines: title top was about
  55 px from the card top and the goal ended about 50 px from the card bottom.
- Radius: 2 px (`rounded-sm`).

## After

Measured in authenticated Chromium against the Portless app route. The desktop
capture and measurements use the same expanded left rail and expanded dock shell
state; the center pane's two-column cards are 368 px wide. The phone capture uses
the phone shell and a true coarse-pointer browser context.

| Viewport | Card | Bounds | Insets | Title/menu top | Radius |
| --- | --- | --- | --- | --- | --- |
| 1440 × 840 | Arc Two, with description | 368 × 128 px | 20 px | 21 px including border | 12 px |
| 1440 × 840 | Book 1, title + goal | 368 × 84 px | 20 px | 21 px including border | 12 px |
| 390 × 844 | Arc Two, with description | 358 × 130 px | 20 px | 21 px including border | 12 px |
| 390 × 844 | Book 1, title + goal | 358 × 86 px | 20 px | 21 px including border | 12 px |

The menu's right inset is also 21 px including the 1 px border in both viewports. The
coarse-pointer menu target remains 44 × 44 px through the existing `min-h-11`/`size-11`
media rule; the fine-pointer Chromium probe rendered the standard 32 × 32 px icon button.

Both linked screenshots hold the `Book 1` current-Work mutation in flight for four
seconds. At capture time the card reported `aria-busy="true"`, both sibling buttons
were natively disabled, and the title/goal owner and edit button each computed to
opacity `0.5`. The card itself remained at opacity `1`, so the edit button was not
dimmed twice. Exact geometry and pending-state values are recorded in the adjacent
`desktop-runtime.json`, `phone-runtime.json`, `desktop-pending-runtime.json`, and
`phone-pending-runtime.json` files.

## Sanitized screenshots

- [`after-desktop-work-sanitized.png`](after-desktop-work-sanitized.png)
- [`after-phone-work-sanitized.png`](after-phone-work-sanitized.png)
