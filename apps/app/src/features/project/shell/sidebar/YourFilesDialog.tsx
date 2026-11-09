import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { UserFilesTree } from "../../context/ContextTreePanel";

/** The writer's own files in a popup over the page. Picking a file opens it and closes the popup. */
export function YourFilesDialog({
  open,
  onOpenChange,
  projectId,
  editorWorkId,
  activeScheme,
  activePath,
  onSelectFile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  editorWorkId: string | null;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  onSelectFile: (scheme: ProjectContextTreeScheme, file: CatalogFile) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(36rem,calc(100%-2rem))] max-w-[min(32rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden rounded-lg p-0">
        <DialogTitle className="px-4 pt-4 pb-2 text-sm font-semibold">{t`Your files`}</DialogTitle>
        <div className="app-scroll min-h-0 flex-1 bg-sidebar pb-2">
          <UserFilesTree
            projectId={projectId}
            editorWorkId={editorWorkId}
            activeScheme={activeScheme}
            activePath={activePath}
            onSelectFile={(scheme, file) => {
              onSelectFile(scheme, file);
              onOpenChange(false);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
