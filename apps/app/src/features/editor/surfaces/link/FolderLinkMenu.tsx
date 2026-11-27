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
      projectId ? { projectId, openDocument: (documentId) => void open({ documentId }) } : null,
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
    <DropdownMenu
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
