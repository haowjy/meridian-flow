import React from "react";
import type { TurnBlock } from "@/features/threads/types";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { ReferencePill, usePillNavigation } from "@/shared/reference-pill";

interface ReferenceBlockProps {
  block: TurnBlock;
}

/**
 * Renders a reference block as a pill showing the document/folder name.
 * Documents open in the editor; folders show a mini tree popover.
 */
export const ReferenceBlock = React.memo(function ReferenceBlock({
  block,
}: ReferenceBlockProps) {
  const refId = block.content?.refId as string | undefined;
  const refType = (block.content?.refType as string) ?? "document";
  const isFolder = refType === "folder";

  const { handlePillClick, folderPopover } = usePillNavigation();

  // Look up the name from the appropriate store collection
  const doc = useTreeStore((s) =>
    isFolder
      ? s.folders.find((f) => f.id === refId)
      : s.documents.find((d) => d.id === refId),
  );

  const displayName =
    doc?.name ?? (isFolder ? "Unknown folder" : "Unknown document");

  // Folders don't have a path field; documents do
  const documentPath =
    doc && "path" in doc
      ? (doc as { path: string }).path
      : (doc?.name ?? refId ?? "Reference");

  return (
    <>
      <ReferencePill
        displayName={displayName}
        iconType={isFolder ? "folder" : "file"}
        onClick={
          refId
            ? (e) => handlePillClick(refId, refType, e.currentTarget)
            : undefined
        }
        documentPath={documentPath}
      />
      {folderPopover}
    </>
  );
});
