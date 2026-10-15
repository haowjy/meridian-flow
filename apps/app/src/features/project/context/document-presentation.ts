import { t } from "@lingui/core/macro";

/** How a host presents one editable document; everything else about the host is shared. */

export type DocumentPresentation = {
  /**
   * Whether this view lets the writer type, with its toolbar. The host's `readOnly` is a
   * different question (the Work's scope is frozen) and is checked against the room's access.
   */
  editable: boolean;
  /** Remote carets and selections inside the editor. */
  collaborationDecorations: boolean;
  /** Overrides the editor's accessible name; read at render so it follows the active locale. */
  ariaLabel?: () => string;
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
  collaborationDecorations: true,
  presenceSuspendsOn: "resolved-review",
  bindingOwner: "desktop-document-host",
};

/** The phone's live document is read-only: a tap selects a change and never raises the keyboard. */
export const PHONE_DOCUMENT_PRESENTATION: DocumentPresentation = {
  editable: false,
  collaborationDecorations: false,
  ariaLabel: () => t`Read-only live document`,
  presenceSuspendsOn: "requested-review",
  bindingOwner: "mobile-project-document-host",
};
