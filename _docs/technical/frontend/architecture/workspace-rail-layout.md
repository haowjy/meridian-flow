---
detail: minimal
audience: developer
---

# Workspace Header Rail & Panel States

Panels (desktop layout):
- Left: **Flow / Chats** (chat list sidebar)
- Center: **Chat** (active conversation)
- Right: **Documents** (tree + editor)

Icons:
- Left edge icon: `MessagesSquare` (Flow)
- Right edge icon: `Folder` (Docs)
- Icons never change shape; only button variant changes:
  - Open (panel visible): `variant="ghost"`
  - Collapsed (panel hidden): `variant="outline"`

## States & Header Rail

Legend:
- `|` = boundary between Flow / Chat / Docs columns
- `[…]` = header segment content within a column

### 1) Left open, Right open

Header rail (all three segments visible):
```text
| [ 💬 ] Meridian / Flow [ + ] | [ Chat header (breadcrumb, actions) ] | [ 📁 ] Test Project [ search ][ + ] |
```

- Flow (left): edge icon `[ 💬 ]` fixed at left; `Meridian / Flow` logo centered within the left panel; `[ + ]` new chat button at right edge of the left header.
- Chat (center): `ChatBreadcrumb` + chat actions; no Flow or Docs toggle icons here.
- Docs (right): edge icon `[ 📁 ]` at left; project title centered within the right panel; trailing cluster `[ search ][ + ]` at right.

### 2) Left open, Right closed

Header rail:
```text
| [ 💬 ] Meridian / Flow [ + ] | [ Chat header ] | [ 📁 ] |
```

- Flow (left): same as state 1 (open).
- Chat (center): unchanged.
- Docs (right): panel body collapsed; header shrinks to a narrow strip showing only the `[ 📁 ]` edge icon.

### 3) Left closed, Right open

Header rail:
```text
| [ 💬 ] | [ Chat header ] | [ 📁 ] Test Project [ search ][ + ] |
```

- Flow (left): panel body collapsed; header reduced to narrow strip with only `[ 💬 ]` icon, aligned with other headers on the rail.
- Chat (center): expands to fill freed horizontal space; no additional toggles.
- Docs (right): same as state 1 (open).

### 4) Left closed, Right closed

Header rail:
```text
| [ 💬 ] | [ Chat header ] | [ 📁 ] |
```

- Flow (left): narrow strip with `[ 💬 ]` icon only.
- Chat (center): main header for workspace.
- Docs (right): narrow strip with `[ 📁 ]` icon only.

## Behavioral Notes

- Collapsed sidebars:
  - Panel body content is hidden.
  - Header strip remains mounted so edge icon stays aligned in the global rail.
  - Strip width is just wide enough for the 8×8 icon button + padding.
- Edge icons:
  - **Single source of truth** for collapse/expand; no mirrored toggles in the center chat header.
  - Click toggles `leftPanelCollapsed` / `rightPanelCollapsed` in `useUIStore`.
- Header height:
  - All three header segments (Flow, Chat, Docs) use the shared `--header-height` token via the `.h-header` utility for a perfectly aligned top rail.

