import React from "react";
import { FileText, Folder } from "lucide-react";
import type { TurnBlock } from "@/features/threads/types";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { openDocument } from "@/core/lib/panelHelpers";
import { useNavigate } from "@tanstack/react-router";

interface ReferenceBlockProps {
  block: TurnBlock;
}

/**
 * Renders a reference block as a pill showing @Name.
 * Documents are clickable (opens in editor); folders are display-only.
 */
export const ReferenceBlock = React.memo(function ReferenceBlock({
  block,
}: ReferenceBlockProps) {
  const navigate = useNavigate();
  const refId = block.content?.refId as string | undefined;
  const refType = (block.content?.refType as string) ?? "document";
  const isFolder = refType === "folder";

  // Look up the name from the appropriate store collection
  const doc = useTreeStore((s) =>
    isFolder
      ? s.folders.find((f) => f.id === refId)
      : s.documents.find((d) => d.id === refId),
  );

  // Derive project slug same way as useResourceOperations
  const projectSlug = useProjectStore((s) => {
    const project = s.currentProject();
    return project?.slug ?? "";
  });

  const handleClick = () => {
    // Folders don't navigate (no editor view); documents open in editor
    if (isFolder || !doc || !projectSlug) return;
    if ("path" in doc) {
      openDocument(doc.id, doc.path, projectSlug, navigate);
    }
  };

  const displayName = doc?.name ?? (isFolder ? "Unknown folder" : "Unknown document");
  const Icon = isFolder ? Folder : FileText;

  // Folders don't have a path field; documents do
  const titleText =
    doc && "path" in doc ? (doc as { path: string }).path : (doc?.name ?? refId ?? "Reference");

  return (
    <button
      onClick={isFolder ? undefined : handleClick}
      className={`bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors ${isFolder ? "cursor-default" : "hover:bg-muted/80"}`}
      title={titleText}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">@{displayName}</span>
    </button>
  );
});
