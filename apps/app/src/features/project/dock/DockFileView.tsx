/** Work-scoped read-only file preview shown in the project dock. */
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { useOpenWorkFileInEditor } from "../routing/use-open-work-file-in-editor";
import { type DockFile, dockFileLocation, useDockViewStore } from "./dock-view-store";

export function DockFileView({ projectId, file }: { projectId: string; file: DockFile }) {
  const closeFile = useDockViewStore((state) => state.closeWorkFile);
  const openInEditor = useOpenWorkFileInEditor(file.workId);

  return (
    <ContextViewerBareHost
      projectId={projectId}
      editorWorkId={file.workId}
      tab={file.tab}
      header={{
        location: dockFileLocation(file.tab),
        action: (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              closeFile();
              openInEditor(file.tab);
            }}
          >
            <Trans>Open in Editor</Trans>
          </Button>
        ),
      }}
    />
  );
}
