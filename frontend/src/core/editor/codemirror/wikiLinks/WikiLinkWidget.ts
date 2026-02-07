/**
 * Wiki-Link Widget
 *
 * Renders wiki-links as pill widgets identical to composer pills, but
 * without the X remove button. Obsidian-style: cursor reveals raw syntax
 * for editing; pill appears when cursor is away.
 *
 * Broken links (unresolved path) get `.cm-wiki-broken` class (dimmed, dashed border).
 */

import { WidgetType } from "@codemirror/view";

// Inline SVG for FileText icon (same as elementWidget.ts — avoids lucide-react in raw DOM)
const FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;

export class WikiLinkWidget extends WidgetType {
  constructor(
    public readonly path: string,
    public readonly displayName: string,
    /** null means document not found → broken link styling */
    public readonly resolvedDocId: string | null,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const pill = document.createElement("span");
    pill.className = "cm-inline-pill";
    if (this.resolvedDocId === null) {
      pill.classList.add("cm-wiki-broken");
      pill.title = `Document not found: ${this.path}`;
    } else {
      pill.title = this.path;
    }

    pill.setAttribute("role", "link");
    pill.setAttribute("aria-label", `Link to ${this.displayName}`);
    pill.dataset.docPath = this.path;
    pill.dataset.displayName = this.displayName;
    if (this.resolvedDocId) {
      pill.dataset.docId = this.resolvedDocId;
    }
    pill.contentEditable = "false";

    // Icon
    const icon = document.createElement("span");
    icon.className = "cm-inline-pill-icon";
    icon.innerHTML = FILE_ICON_SVG;
    pill.appendChild(icon);

    // Display name (truncated via CSS)
    const name = document.createElement("span");
    name.className = "cm-inline-pill-name";
    name.textContent = this.displayName;
    pill.appendChild(name);

    // No X button — Obsidian-style: cursor reveals raw syntax for editing

    return pill;
  }

  eq(other: WikiLinkWidget): boolean {
    return (
      this.path === other.path &&
      this.displayName === other.displayName &&
      this.resolvedDocId === other.resolvedDocId
    );
  }

  /** Let mousedown through to domEventHandlers for pill click navigation. */
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown";
  }
}
