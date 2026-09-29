/** Work-scoped read-only file preview shown in the project dock. */
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { type DockFile, dockFileLocation } from "./dock-view-store";

// Scratch and Uploads have no Editor destination, so the dock is their only viewer.
export function DockFileView({ projectId, file }: { projectId: string; file: DockFile }) {
  return (
    <ContextViewerBareHost
      projectId={projectId}
      editorWorkId={file.workId}
      tab={file.tab}
      header={{ location: dockFileLocation(file.tab) }}
    />
  );
}
