/** How a host presents one editable document; everything else about the host is shared. */

export type DocumentPresentation = {
  /**
   * Whether this view lets the writer type, with its toolbar. The host's `readOnly` is a
   * different question (the Work's scope is frozen) and is checked against the room's access.
   */
  editable: boolean;
  /** A review body that takes no typing: a tap on the phone's selects a change. */
  reviewReadOnly: boolean;
  /** Remote carets and selections inside the editor. */
  collaborationDecorations: boolean;
  /**
   * When the live editor stands down its presence: from the click that requests a review
   * (the intent), or only once the review's room has resolved.
   */
  presenceSuspendsOn: "requested-review" | "resolved-review";
  /** Names the live binding in diagnostics. */
  bindingOwner: "desktop-document-host" | "mobile-project-document-host";
};

export const DESKTOP_DOCUMENT_PRESENTATION: DocumentPresentation = {
  editable: true,
  reviewReadOnly: false,
  collaborationDecorations: true,
  presenceSuspendsOn: "resolved-review",
  bindingOwner: "desktop-document-host",
};

export const PHONE_DOCUMENT_PRESENTATION: DocumentPresentation = {
  editable: true,
  reviewReadOnly: true,
  collaborationDecorations: false,
  presenceSuspendsOn: "requested-review",
  bindingOwner: "mobile-project-document-host",
};
