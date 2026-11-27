export type DocumentPresentation = {
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
