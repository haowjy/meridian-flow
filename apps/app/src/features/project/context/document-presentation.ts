export type DocumentPresentation = {
  /**
   * Whether this view lets the writer type, with its toolbar. The host's `readOnly` is a
   * different question (the Work's scope is frozen) and is checked against the room's access.
   */
  editable: boolean;
  collaborationDecorations: boolean;
  bindingOwner: "desktop-document-host" | "mobile-project-document-host";
};

export const DESKTOP_DOCUMENT_PRESENTATION: DocumentPresentation = {
  editable: true,
  collaborationDecorations: true,
  bindingOwner: "desktop-document-host",
};

export const PHONE_DOCUMENT_PRESENTATION: DocumentPresentation = {
  editable: true,
  collaborationDecorations: false,
  bindingOwner: "mobile-project-document-host",
};
