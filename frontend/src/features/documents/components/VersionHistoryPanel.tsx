import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/core/lib/api";
import { isAbortError } from "@/core/lib/errors";
import { useUIStore } from "@/core/stores/useUIStore";
import { Button } from "@/shared/components/ui/button";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { X, Plus, RotateCcw, Trash2, Clock, Bookmark, Shield } from "lucide-react";
import type { DocumentSnapshot } from "@/features/documents/types/snapshot";
import { cn } from "@/lib/utils";

interface VersionHistoryPanelProps {
  documentId: string;
}

/**
 * Google Docs-style version history right panel.
 * Shows timestamped snapshots grouped by type: named snapshots as "restore points",
 * auto snapshots as system safety nets.
 */
export function VersionHistoryPanel({ documentId }: VersionHistoryPanelProps) {
  const [snapshots, setSnapshots] = useState<DocumentSnapshot[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newSnapshotName, setNewSnapshotName] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadSnapshots = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    try {
      const result = await api.snapshots.list(documentId, {
        limit: 50,
        signal: controller.signal,
      });
      setSnapshots(result.snapshots);
      setTotal(result.total);
    } catch (err) {
      if (isAbortError(err)) return;
      setError("Failed to load version history");
    } finally {
      setIsLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    loadSnapshots();
    return () => abortRef.current?.abort();
  }, [loadSnapshots]);

  const handleCreate = async () => {
    if (!newSnapshotName.trim()) return;
    setIsCreating(true);
    try {
      await api.snapshots.create(documentId, newSnapshotName.trim());
      setNewSnapshotName("");
      setShowCreateForm(false);
      await loadSnapshots();
    } catch (err) {
      if (!isAbortError(err)) {
        setError("Failed to create snapshot");
      }
    } finally {
      setIsCreating(false);
    }
  };

  const handleRestore = async (snapshotId: string) => {
    setRestoringId(snapshotId);
    try {
      await api.snapshots.restore(documentId, snapshotId);
      await loadSnapshots();
      // Reload the page to pick up restored Yjs state
      window.location.reload();
    } catch (err) {
      if (!isAbortError(err)) {
        setError("Failed to restore snapshot");
      }
      setRestoringId(null);
    }
  };

  const handleDelete = async (snapshotId: string) => {
    setDeletingId(snapshotId);
    try {
      await api.snapshots.delete(documentId, snapshotId);
      setSnapshots((prev) => prev.filter((s) => s.id !== snapshotId));
      setTotal((prev) => prev - 1);
    } catch (err) {
      if (!isAbortError(err)) {
        setError("Failed to delete snapshot");
      }
    } finally {
      setDeletingId(null);
    }
  };

  const close = () => useUIStore.getState().setShowVersionHistory(false);

  const snapshotIcon = (type: DocumentSnapshot["snapshotType"]) => {
    switch (type) {
      case "named":
        return <Bookmark className="text-primary h-3.5 w-3.5" />;
      case "pre_restore":
        return <Shield className="text-warning h-3.5 w-3.5" />;
      case "auto":
      default:
        return <Clock className="text-muted-foreground h-3.5 w-3.5" />;
    }
  };

  const snapshotLabel = (snap: DocumentSnapshot) => {
    if (snap.name) return snap.name;
    switch (snap.snapshotType) {
      case "pre_restore":
        return "Pre-restore backup";
      case "auto":
        return "Auto-save checkpoint";
      default:
        return "Snapshot";
    }
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="bg-background flex h-full flex-col border-l">
      {/* Header */}
      <div className="border-border/50 flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-medium">Version History</h3>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={close}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Create snapshot */}
      <div className="border-border/50 border-b px-3 py-2">
        {showCreateForm ? (
          <div className="flex flex-col gap-1.5">
            <input
              type="text"
              className="border-border bg-background text-sm rounded border px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Snapshot name..."
              value={newSnapshotName}
              onChange={(e) => setNewSnapshotName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setShowCreateForm(false);
              }}
              autoFocus
              disabled={isCreating}
            />
            <div className="flex gap-1">
              <Button
                size="sm"
                className="h-6 text-xs"
                onClick={handleCreate}
                disabled={isCreating || !newSnapshotName.trim()}
              >
                {isCreating ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => setShowCreateForm(false)}
                disabled={isCreating}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full text-xs"
            onClick={() => setShowCreateForm(true)}
          >
            <Plus className="mr-1 h-3 w-3" />
            Create Restore Point
          </Button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-destructive/10 text-destructive px-3 py-1.5 text-xs">
          {error}
          <Button
            variant="ghost"
            size="sm"
            className="ml-1 h-4 text-xs underline"
            onClick={() => {
              setError(null);
              loadSnapshots();
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Snapshot list */}
      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground text-xs">Loading...</div>
          </div>
        ) : snapshots.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
            <Clock className="text-muted-foreground mb-2 h-8 w-8 opacity-50" />
            <p className="text-muted-foreground text-xs">No snapshots yet</p>
            <p className="text-muted-foreground mt-1 text-xs opacity-70">
              Create a restore point to save your current progress
            </p>
          </div>
        ) : (
          <div className="divide-border/50 divide-y">
            {snapshots.map((snap) => (
              <div
                key={snap.id}
                className={cn(
                  "group flex flex-col gap-1 px-3 py-2 transition-colors hover:bg-muted/50",
                  snap.snapshotType === "auto" && "opacity-70",
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 shrink-0">{snapshotIcon(snap.snapshotType)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">
                      {snapshotLabel(snap)}
                    </div>
                    <div className="text-muted-foreground text-[10px]">
                      {formatDate(snap.createdAt)}
                    </div>
                  </div>
                </div>
                {/* Actions: visible on hover */}
                <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() => handleRestore(snap.id)}
                    disabled={restoringId !== null}
                  >
                    <RotateCcw className="mr-0.5 h-2.5 w-2.5" />
                    {restoringId === snap.id ? "Restoring..." : "Restore"}
                  </Button>
                  {snap.snapshotType === "named" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive h-5 px-1.5 text-[10px]"
                      onClick={() => handleDelete(snap.id)}
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
        {total > snapshots.length && (
          <div className="text-muted-foreground px-3 py-2 text-center text-[10px]">
            Showing {snapshots.length} of {total} snapshots
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
