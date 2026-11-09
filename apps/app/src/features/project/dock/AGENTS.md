# features/project/dock — Dock document container

The dock owns no session, room, capture or review controller; it shows the selected tab through the
same `ContextDocumentHost` as the Editor. It has no document store of its own.

- Keep the primary body mounted at one tree depth across center and dock placement. Cover it with an inert
  overlay rather than unmounting it.
- Admission of a review launch doesn't wait for the draft list; the review's fresh entry read owns absence.
- Launch and address owners hold no paint state: pane continuity belongs to
  [`PaintHold`](../../../components/app/PaintHold.md).

Slot, placement and review contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
