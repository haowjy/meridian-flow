/**
 * usePillNavigation — Shared hook for reference pill click handling
 *
 * Replaces the duplicate handlePillClick logic in TurnInput, UserTurn,
 * EditTurnInput, and ReferenceBlock.
 *
 * - Document pill click -> opens the document in the editor panel
 * - Folder pill click -> shows a FolderContentPopover anchored to the pill
 */

import { useState, useCallback, type ReactNode } from "react";
import { createElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { openDocument } from "@/core/lib/panelHelpers";
import type { Document } from "@/features/documents/types/document";
import { FolderContentPopover } from "./FolderContentPopover";

interface PopoverState {
  folderId: string;
  anchorEl: HTMLElement;
}

interface PillNavigationResult {
  /** Click handler for pills — pass the ref ID, type, and the DOM element */
  handlePillClick: (id: string, refType: string, anchorEl: HTMLElement) => void;
  /** Render this in your component to show the folder popover when active */
  folderPopover: ReactNode;
}

export function usePillNavigation(): PillNavigationResult {
  const navigate = useNavigate();
  const [popover, setPopover] = useState<PopoverState | null>(null);

  const handlePillClick = useCallback(
    (id: string, refType: string, anchorEl: HTMLElement) => {
      if (refType === "folder") {
        setPopover({ folderId: id, anchorEl });
        return;
      }

      // Document click -> navigate to editor
      const doc = useTreeStore.getState().documents.find((d) => d.id === id);
      if (!doc) return;
      const projectSlug =
        useProjectStore.getState().currentProject()?.slug ?? "";
      if (!projectSlug) return;
      openDocument(doc.id, doc.path, projectSlug, navigate);
    },
    [navigate],
  );

  const handleClose = useCallback(() => setPopover(null), []);

  const handleDocumentClick = useCallback(
    (doc: Document) => {
      const projectSlug =
        useProjectStore.getState().currentProject()?.slug ?? "";
      if (!projectSlug) return;
      openDocument(doc.id, doc.path, projectSlug, navigate);
    },
    [navigate],
  );

  const folderPopover: ReactNode = popover
    ? createElement(FolderContentPopover, {
        folderId: popover.folderId,
        anchorEl: popover.anchorEl,
        onClose: handleClose,
        onDocumentClick: handleDocumentClick,
      })
    : null;

  return { handlePillClick, folderPopover };
}
