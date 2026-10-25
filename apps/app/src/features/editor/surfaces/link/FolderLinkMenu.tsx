/**
 * A folder link's menu in the Editor: the drill-in menu inside the folder,
 * hung under the link the writer pressed. A document picked there opens the
 * way this editor's links open documents.
 *
 * It registers as a chrome layer like `EditorMenu`, so the Esc chain knows its
 * place and closing hands the caret back to the prose.
 */

import type { Editor } from "@tiptap/core";
import { useMemo } from "react";

import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { LinkFolderRequest, LinkSurface } from "@/core/editor/links";
import { pointerAnchorStyle, useChromeLayer } from "@/features/editor/chrome";
import { FolderMenuBody, type FolderMenuHost } from "@/features/project/context/FolderMenu";

import { useEditorScope } from "../../editor-scope";
import { useEditorLinkDestination } from "./ProjectLinkRuntime";

export function FolderLinkMenu({
  editor,
  surface,
  folder,
}: {
  editor: Editor;
  surface: LinkSurface;
  folder: LinkFolderRequest;
}) {
  const close = () => surface.closeFolder();
  const { projectId } = useEditorScope();
  const open = useEditorLinkDestination();
  const host = useMemo<FolderMenuHost | null>(
    () =>
      projectId
        ? { projectId, openDocument: (documentId) => void open({ documentId }, "current") }
        : null,
    [open, projectId],
  );
  const layer = useChromeLayer(editor, {
    id: "folder-link-menu",
    open: true,
    close,
    dismissal: "self",
  });
  if (!host) return null;
  return (
    // A menu summoned at a new point is a new menu (see `EditorMenu`).
    <DropdownMenu
      key={folder.seq}
      open
      modal={false}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DropdownMenuTrigger aria-hidden tabIndex={-1} style={pointerAnchorStyle(folder.at)} />
      <FolderMenuBody
        host={host}
        folderId={folder.folderId}
        onCloseAutoFocus={layer.onCloseAutoFocus}
        onEscapeKeyDown={layer.onEscapeKeyDown}
      />
    </DropdownMenu>
  );
}
