import type { ReactNode } from "react";
import { Button } from "@/shared/components/ui/button";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import type { DocumentSnapshot } from "@/features/documents/types/snapshot";
import { SnapshotPreviewDiff } from "./SnapshotPreviewDiff";

interface SnapshotPreviewPaneProps {
  snapshot: DocumentSnapshot | null;
  selectedSnapshotId: string | null;
  previewBaseContent: string;
  previewContent: string;
  isPreviewLoading: boolean;
  previewError: string | null;
  restoringId: string | null;
  canSwitchPrev: boolean;
  canSwitchNext: boolean;
  formatDate: (date: Date) => string;
  snapshotIcon: (type: DocumentSnapshot["snapshotType"]) => ReactNode;
  snapshotLabel: (snap: DocumentSnapshot) => string;
  onSwitchPrev: () => void;
  onSwitchNext: () => void;
  onRestore: () => void;
  onClosePreview: () => void;
  onRetryPreview: () => void;
}

export function SnapshotPreviewPane({
  snapshot,
  selectedSnapshotId,
  previewBaseContent,
  previewContent,
  isPreviewLoading,
  previewError,
  restoringId,
  canSwitchPrev,
  canSwitchNext,
  formatDate,
  snapshotIcon,
  snapshotLabel,
  onSwitchPrev,
  onSwitchNext,
  onRestore,
  onClosePreview,
  onRetryPreview,
}: SnapshotPreviewPaneProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/50 border-b px-3 py-2">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 shrink-0">
            {snapshot ? snapshotIcon(snapshot.snapshotType) : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">
              {snapshot ? snapshotLabel(snapshot) : "Snapshot preview"}
            </div>
            <div className="text-muted-foreground text-[10px]">
              {snapshot ? formatDate(snapshot.createdAt) : ""}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={onSwitchPrev}
            disabled={!canSwitchPrev || isPreviewLoading}
          >
            <ChevronLeft className="mr-0.5 h-2.5 w-2.5" />
            Newer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={onSwitchNext}
            disabled={!canSwitchNext || isPreviewLoading}
          >
            Older
            <ChevronRight className="ml-0.5 h-2.5 w-2.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={onRestore}
            disabled={restoringId !== null || selectedSnapshotId == null}
          >
            <RotateCcw className="mr-0.5 h-2.5 w-2.5" />
            {restoringId === selectedSnapshotId ? "Restoring..." : "Restore"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={onClosePreview}
          >
            Close preview
          </Button>
        </div>
        <div className="text-muted-foreground mt-2 text-[10px]">
          Comparing current document (left) to selected snapshot (right)
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {isPreviewLoading ? (
          <div className="flex h-full items-center justify-center py-8">
            <div className="text-muted-foreground text-xs">
              Loading preview...
            </div>
          </div>
        ) : previewError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
            <p className="text-destructive text-xs">{previewError}</p>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={onRetryPreview}
              >
                Retry preview
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={onClosePreview}
              >
                Back to list
              </Button>
            </div>
          </div>
        ) : snapshot ? (
          <SnapshotPreviewDiff
            baseText={previewBaseContent}
            snapshotText={previewContent}
          />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center py-8 text-xs">
            Snapshot preview unavailable
          </div>
        )}
      </div>
    </div>
  );
}
