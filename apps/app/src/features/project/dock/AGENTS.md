# features/project/dock — Dock document container

The dock owns no session, room, capture or review controller; a document here uses the same
`ContextDocumentHost` as an Editor tab.

- Keep the primary body mounted at one tree depth across center and dock placement. Cover it with an inert
  overlay rather than unmounting it.
- Admission of a review launch doesn't wait for the draft list; the review's fresh entry read owns absence.
- Launch and address owners hold no paint state: pane continuity belongs to
  [`PaintHold`](../../../components/app/PaintHold.md).

Slot, placement, restoration and review contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
