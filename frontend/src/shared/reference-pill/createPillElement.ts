/**
 * Reference Pill DOM Builder
 *
 * Creates pill DOM elements for CM6 Widget contexts (composer, future widgets).
 * Uses CSS classes from pill.css — no inline styles.
 *
 * The resulting element has:
 * - Icon (file or folder SVG)
 * - Display name (truncated via CSS)
 * - Optional X button (hidden by default, shown on hover via CSS)
 */

import {
  PILL_CLASS,
  PILL_ICON_CLASS,
  PILL_NAME_CLASS,
  PILL_REMOVE_CLASS,
  PILL_BROKEN_CLASS,
} from "./constants";
import { FILE_ICON_SVG, FOLDER_ICON_SVG, CLOSE_ICON_SVG } from "./icons";

export interface PillOptions {
  displayName: string;
  iconType: "file" | "folder";
  documentId?: string;
  documentPath?: string;
  broken?: boolean;
  editable?: boolean;
  onRemove?: () => void;
}

/**
 * Build a pill DOM element for CM6 widget contexts.
 *
 * Layout: [icon] [name] [X button]
 * The X button replaces the icon on hover (handled by CSS).
 */
export function createPillElement(options: PillOptions): HTMLElement {
  const {
    displayName,
    iconType,
    documentId,
    documentPath,
    broken = false,
    editable = false,
    onRemove,
  } = options;

  const pill = document.createElement("span");
  pill.className = broken ? `${PILL_CLASS} ${PILL_BROKEN_CLASS}` : PILL_CLASS;

  const baseTitle = documentPath ?? displayName;
  pill.title = editable
    ? `${baseTitle}\nClick center to open, edge to place caret`
    : baseTitle;
  pill.setAttribute("role", "img");
  pill.setAttribute("aria-label", `Reference to ${displayName}`);
  if (documentId) {
    pill.dataset.documentId = documentId;
  }
  // Encode the ref type so CM6 click handlers can distinguish folder vs document
  pill.dataset.refType = iconType === "folder" ? "folder" : "document";
  // Prevent CM6 from treating pill as editable text
  pill.contentEditable = "false";

  // Icon element
  const icon = document.createElement("span");
  icon.className = PILL_ICON_CLASS;
  icon.innerHTML = iconType === "folder" ? FOLDER_ICON_SVG : FILE_ICON_SVG;
  pill.appendChild(icon);

  // Display name (truncated via CSS)
  const name = document.createElement("span");
  name.className = PILL_NAME_CLASS;
  name.textContent = displayName;
  pill.appendChild(name);

  // X button — only added in editable mode so it can't be clicked in read-only.
  // Hidden by default, shown on hover (CSS swaps icon → X button).
  if (editable && onRemove) {
    const removeBtn = document.createElement("button");
    removeBtn.className = PILL_REMOVE_CLASS;
    removeBtn.type = "button";
    removeBtn.title = "Remove reference";
    removeBtn.dataset.action = "remove";
    removeBtn.innerHTML = CLOSE_ICON_SVG;
    removeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRemove();
    };
    pill.appendChild(removeBtn);
  }

  return pill;
}
