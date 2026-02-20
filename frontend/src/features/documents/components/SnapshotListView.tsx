import type { ReactNode } from "react";
import { Button } from "@/shared/components/ui/button";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { Clock, Trash2 } from "lucide-react";
import type { DocumentSnapshot } from "@/features/documents/types/snapshot";
import { cn } from "@/lib/utils";

interface SnapshotListViewProps {
  snapshots: DocumentSnapshot[];
  filteredSnapshots: DocumentSnapshot[];
  total: number;
  originFilter: "all" | "human" | "ai";
  isLoading: boolean;
  isPreviewLoading: boolean;
  deletingId: string | null;
  snapshotIcon: (type: DocumentSnapshot["snapshotType"]) => ReactNode;
  snapshotLabel: (snapshot: DocumentSnapshot) => string;
  renderOriginBadge: (snapshot: DocumentSnapshot) => ReactNode;
  formatDate: (date: Date) => string;
  onOpenPreview: (snapshot: DocumentSnapshot) => void;
  onDelete: (snapshotId: string) => void;
}

export function SnapshotListView({
  snapshots,
  filteredSnapshots,
  total,
  originFilter,
  isLoading,
  isPreviewLoading,
  deletingId,
  snapshotIcon,
  snapshotLabel,
  renderOriginBadge,
  formatDate,
  onOpenPreview,
  onDelete,
}: SnapshotListViewProps) {
  return (
    <ScrollArea className="flex-1">
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="text-muted-foreground text-xs">Loading...</div>
        </div>
      ) : filteredSnapshots.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
          <Clock className="text-muted-foreground mb-2 h-8 w-8 opacity-50" />
          <p className="text-muted-foreground text-xs">
            {snapshots.length === 0
              ? "No snapshots yet"
              : `No ${originFilter} snapshots`}
          </p>
          <p className="text-muted-foreground mt-1 text-xs opacity-70">
            {snapshots.length === 0
              ? "Create a restore point to save your current progress"
              : "Try a different filter"}
          </p>
        </div>
      ) : (
        <div className="divide-border/50 divide-y">
          {filteredSnapshots.map((snap) => (
            <div
              key={snap.id}
              className={cn(
                "group hover:bg-muted/50 flex cursor-pointer flex-col gap-1 px-3 py-2 transition-colors",
                (snap.snapshotType === "auto" ||
                  snap.snapshotType === "auto_human" ||
                  snap.snapshotType === "auto_ai_accept") &&
                  "opacity-70",
              )}
              onClick={() => onOpenPreview(snap)}
            >
              <div className="flex items-start gap-2">
                <div className="mt-0.5 shrink-0">
                  {snapshotIcon(snap.snapshotType)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <div className="truncate text-xs font-medium">
                      {snapshotLabel(snap)}
                    </div>
                    {renderOriginBadge(snap)}
                  </div>
                  <div className="text-muted-foreground text-[10px]">
                    {formatDate(snap.createdAt)}
                  </div>
                </div>
              </div>
              <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPreview(snap);
                  }}
                  disabled={isPreviewLoading}
                >
                  Preview
                </Button>
                {snap.snapshotType === "named" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive h-5 px-1.5 text-[10px]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(snap.id);
                    }}
                    disabled={deletingId !== null}
                  >
                    <Trash2 className="mr-0.5 h-2.5 w-2.5" />
                    {deletingId === snap.id ? "..." : "Delete"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {total > snapshots.length && originFilter === "all" && (
        <div className="text-muted-foreground px-3 py-2 text-center text-[10px]">
          Showing {snapshots.length} of {total} snapshots
        </div>
      )}
      {originFilter !== "all" && filteredSnapshots.length > 0 && (
        <div className="text-muted-foreground px-3 py-2 text-center text-[10px]">
          Showing {filteredSnapshots.length} {originFilter} snapshot
          {filteredSnapshots.length !== 1 ? "s" : ""}
        </div>
      )}
    </ScrollArea>
  );
}
