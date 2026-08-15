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

Measured in authenticated Chromium against the Portless app route.

| Viewport | Card | Bounds | Insets | Title/menu top | Radius |
| --- | --- | --- | --- | --- | --- |
| 1440 × 840 | Arc Two, with description | 368 × 128 px | 20 px | 21 px including border | 8 px |
| 1440 × 840 | Book 1, title + goal | 368 × 84 px | 20 px | 21 px including border | 8 px |
| 390 × 844 | Arc Two, with description | 358 × 128 px | 20 px | 21 px including border | 8 px |
| 390 × 844 | Book 1, title + goal | 358 × 84 px | 20 px | 21 px including border | 8 px |

The menu's right inset is also 21 px including the 1 px border in both viewports. The
coarse-pointer menu target remains 44 × 44 px through the existing `min-h-11`/`size-11`
media rule; the fine-pointer Chromium probe rendered the standard 32 × 32 px icon button.

## Sanitized screenshots

- [`after-desktop-work-sanitized.png`](after-desktop-work-sanitized.png)
- [`after-phone-work-sanitized.png`](after-phone-work-sanitized.png)
