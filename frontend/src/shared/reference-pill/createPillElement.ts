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
import {
  resolvePillBehavior,
  pillBehaviorToDataAttributes,
  type PillBehaviorInput,
} from "./behavior";
import { FILE_ICON_SVG, FOLDER_ICON_SVG, CLOSE_ICON_SVG } from "./icons";

export interface PillOptions {
  displayName: string;
  iconType: "file" | "folder";
  documentId?: string;
  documentPath?: string;
  broken?: boolean;
  behavior?: PillBehaviorInput;
  onRemove?: () => void;
}

/**
 * Build a pill DOM element for CM6 widget contexts.
 *
 * Layout: [icon] [name] [X button]
 * Remove affordance is behavior-driven via data attributes (handled by CSS).
 */
export function createPillElement(options: PillOptions): HTMLElement {
  const {
    displayName,
    iconType,
    documentId,
    documentPath,
    broken = false,
    behavior,
    onRemove,
  } = options;

  const resolvedBehavior = resolvePillBehavior({
    // Default navigation follows the presence of a concrete reference target.
    canNavigate: documentId !== undefined,
    canRemove: Boolean(onRemove),
    ...behavior,
  });
  // Guard against invalid state: removable behavior without a handler.
  const finalBehavior = resolvePillBehavior({
    ...resolvedBehavior,
    canRemove: resolvedBehavior.canRemove && Boolean(onRemove),
  });

  const pill = document.createElement("span");
  const pillClass = [PILL_CLASS, broken ? PILL_BROKEN_CLASS : ""]
    .filter(Boolean)
    .join(" ");
  pill.className = pillClass;
  const behaviorAttrs = pillBehaviorToDataAttributes(finalBehavior);
  pill.setAttribute("data-pill-navigable", behaviorAttrs["data-pill-navigable"]);
  pill.setAttribute("data-pill-removable", behaviorAttrs["data-pill-removable"]);
  pill.setAttribute(
    "data-pill-hover-swap",
    behaviorAttrs["data-pill-hover-swap"],
  );

  const baseTitle = documentPath ?? displayName;
  pill.title = finalBehavior.canRemove
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

  // X button — only added when remove behavior is enabled.
  // Hidden by default, shown on hover when hover-swap is enabled in CSS.
  if (finalBehavior.canRemove && onRemove) {
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
