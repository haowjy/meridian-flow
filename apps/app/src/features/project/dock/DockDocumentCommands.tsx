/**
 * DockDocumentCommands — the buttons at the left of an open dock document's
 * header: Close document and Open in Editor; a view that could not open says
 * so in a line under the header, which Open in Editor is described by.
 */
import { t } from "@lingui/core/macro";
import { Maximize2, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { type OpenDocumentTab, useOpenDocumentActions } from "../open-documents";
import { useScreenCommands } from "../routing/ProjectNavigationContext";

export function DockDocumentCommands({
  projectId,
  document,
}: {
  projectId: string;
  document: OpenDocumentTab;
}) {
  const showEditor = useScreenCommands()?.showEditor;
  const { close } = useOpenDocumentActions(projectId);
  const coarse = "[@media(pointer:coarse)]:size-11";
  return (
    <>
      <IconButton
        size="sm"
        tooltip={t`Close document`}
        className={coarse}
        onClick={() => close(document.key)}
      >
        <X aria-hidden className="size-4" />
      </IconButton>
      <IconButton
        size="sm"
        tooltip={t`Open in Editor`}
        className={coarse}
        onClick={() => void showEditor?.()}
      >
        <Maximize2 aria-hidden className="size-4" />
      </IconButton>
    </>
  );
}
